"""Scheduled jobs. They read, refresh and notify. They never place an order.

Jobs (service/config.json "jobs"):
  schedule  trading days and hours from the exchange (tinvest schedule --write); with it
            market_open() follows the real calendar (holidays, short days), else the config hours
  quotes    refresh trader/prices.json for the portfolio tickers (tinvest quote --write)
  alerts    evaluate trader/alerts.json against trader/prices.json, ring in Telegram
  snapshot  record the portfolio value at the start of the day (trader/state/day.json)
  guard     if the portfolio fell more than max_daily_loss_pct since the snapshot,
            pull the kill switch (trader/state/halt.json) and say so
  digest    evening summary: portfolio, today's decisions, kill switch state
  news      new stories naming your stocks (important ones only, to keep it quiet)

A job runs every N minutes ("every_min") or once a day at "at" (HH:MM local),
optionally only during market hours (Moscow, Mon to Fri by default; MOEX holidays
are not in this version, so a job may run on a holiday and find nothing).
"""

import datetime
import threading
import time

from .bot import portfolio_view, html
from .state import record_history


class Scheduler(object):
    def __init__(self, pack, notify, cfg, clock=None):
        self.pack, self.notify, self.cfg = pack, notify, cfg
        self.tz = datetime.timezone(datetime.timedelta(hours=float(cfg.get("timezone_offset_hours", 3))))
        self.clock = clock or (lambda: datetime.datetime.now(self.tz))
        self.jobs = [dict(j) for j in cfg.get("jobs", [])]
        self.last = {}        # name -> datetime of the last run
        self.last_result = {}  # name -> short text
        self.errors_said = {}  # error text -> when it was last sent (throttle)
        now = self.clock()
        self.skipped = set()
        for j in self.jobs:  # an "at" job whose time already passed today does not fire at start-up
            if j.get("at") and self._at_passed(j, now):
                self.last[j["name"]] = now
                self.skipped.add(j["name"])
                self.last_result[j["name"]] = "время уже прошло при запуске, ждёт следующего дня"
        self.stop = threading.Event()

    # ------------------------------------------------------------ time
    def now(self):
        n = self.clock()
        return n if n.tzinfo else n.replace(tzinfo=self.tz)

    def schedule_for(self, now):
        """Today's entry from trader/state/schedule.json, or None."""
        doc = self.pack.read("trader/state/schedule.json", None) or {}
        return (doc.get("days") or {}).get(now.date().isoformat())

    def market_open(self, now=None):
        now = now or self.now()
        day = self.schedule_for(now)
        if day is not None:
            if not day.get("trading"):
                return False
            try:
                start = datetime.datetime.fromisoformat(str(day["start"]).replace("Z", "+00:00"))
                end = datetime.datetime.fromisoformat(str(day["end"]).replace("Z", "+00:00"))
                return start <= now.astimezone(datetime.timezone.utc) < end
            except (KeyError, TypeError, ValueError):
                pass  # odd entry: fall back to the config hours
        mh = self.cfg.get("market_hours") or {}
        days = mh.get("days", [0, 1, 2, 3, 4])
        if now.weekday() not in days:
            return False
        hhmm = now.strftime("%H:%M")
        return mh.get("open", "10:00") <= hhmm < mh.get("close", "18:50")

    def _at_passed(self, job, now):
        return now.strftime("%H:%M") >= job["at"] and now.weekday() in job.get("days", [0, 1, 2, 3, 4, 5, 6])

    def due(self, now=None):
        now = now or self.now()
        out = []
        # the calendar first: if today's entry is missing, fetch it (at most once an hour)
        if any(j["name"] == "schedule" for j in self.jobs) and self.schedule_for(now) is None:
            last = None if "schedule" in self.skipped else self.last.get("schedule")
            if last is None or (now - last).total_seconds() >= 3600:
                out.append("schedule")
        for j in self.jobs:
            if j["name"] in out:
                continue
            name, last = j["name"], self.last.get(j["name"])
            if j.get("market_hours_only") and not self.market_open(now):
                continue
            if j.get("every_min"):
                if last is None or (now - last).total_seconds() >= 60 * float(j["every_min"]):
                    out.append(name)
            elif j.get("at"):
                if self._at_passed(j, now) and (last is None or last.date() != now.date()):
                    out.append(name)
        return out

    # ------------------------------------------------------------ running
    def tick(self, now=None):
        now = now or self.now()
        ran = []
        for name in self.due(now):
            self.last[name] = now
            self.skipped.discard(name)
            fn = getattr(self, "job_" + name, None)
            if not fn:
                self.last_result[name] = "неизвестная задача"
                continue
            try:
                self.last_result[name] = fn(now) or "ok"
            except Exception as exc:
                self.last_result[name] = "ошибка: %s" % str(exc)[:200]
                self.say_error("%s: %s" % (name, str(exc)[:300]), now)
            ran.append(name)
        return ran

    def loop(self, period=30):
        while not self.stop.is_set():
            try:
                self.tick()
            except Exception as exc:  # pragma: no cover
                self.say_error("планировщик: %s" % exc, self.now())
            self.stop.wait(period)

    def start(self):
        t = threading.Thread(target=self.loop, name="scheduler", daemon=True)
        t.start()
        return t

    def say_error(self, text, now, throttle_min=60):
        seen = self.errors_said.get(text)
        if seen and (now - seen).total_seconds() < 60 * throttle_min:
            return
        self.errors_said[text] = now
        self.notify("⚠ " + html(text))

    # ------------------------------------------------------------ jobs
    def job_schedule(self, now):
        code, out, err = self.pack.schedule()
        if code != 0:
            raise RuntimeError("schedule: " + (err or out).strip()[:300])
        day = self.schedule_for(now)
        if day is None:
            return "получено, сегодня в календаре нет"
        return "сегодня %s" % ("торговый день" if day.get("trading") else "биржа закрыта")

    def job_quotes(self, now):
        code, out, err = self.pack.quote()
        if code != 0:
            raise RuntimeError("quotes: " + (err or out).strip()[:300])
        return "цены обновлены"

    def job_alerts(self, now):
        res = self.pack.alerts_check()
        for r in res.get("rings", []):
            self.notify("🔔 " + html(r["message"]))
        errs = [e for e in res.get("errors", []) if "no rules" not in e]
        if errs:
            raise RuntimeError("; ".join(errs)[:300])
        return "%d сработало" % len(res.get("rings", []))

    def _total(self):
        code, out, err = self.pack.portfolio()
        if code != 0:
            raise RuntimeError("portfolio: " + (err or out).strip()[:300])
        text, total = portfolio_view(self.pack)
        return text, total

    def job_snapshot(self, now):
        text, total = self._total()
        self.pack.write("trader/state/day.json", {"date": now.date().isoformat(), "start_total": round(total, 2),
                                                  "at": now.replace(microsecond=0).isoformat()})
        record_history(self.pack, now, "open")
        return "старт дня %.0f" % total

    def job_guard(self, now):
        day = self.pack.read("trader/state/day.json", {}) or {}
        if day.get("date") != now.date().isoformat() or not day.get("start_total"):
            return self.job_snapshot(now)
        text, total = self._total()
        record_history(self.pack, now, "tick")
        start = float(day["start_total"])
        drop = 100.0 * (1 - total / start) if start else 0.0
        limit = float(self.cfg.get("max_daily_loss_pct") or 0)
        if limit and drop >= limit and not self.pack.halted():
            self.pack.halt("дневной убыток %.2f%% при лимите %.1f%%" % (drop, limit), "guard")
            self.notify("⛔ <b>Стоп-кран</b>: портфель упал на %.2f%% с начала дня (лимит %.1f%%). "
                        "Ордера не отправляются до /resume.\n%s" % (drop, limit, text))
            return "СТОП: %.2f%%" % drop
        return "изменение за день %+.2f%%" % (-drop)

    def job_news(self, now):
        doc = self.pack.news(only_mine=True, state="trader/state/moex_news_job.json")  # its own memory
        sent = 0
        for it in doc.get("items", []):
            if not it.get("important"):
                continue
            self.notify('📰 <b>%s</b> <a href="%s">%s</a>%s' % (
                html(",".join(it.get("touches", []))), html(it.get("link", "")), html(it.get("title", "")),
                ("\n<i>%s</i>" % html(", ".join(it["tags"]))) if it.get("tags") else ""))
            sent += 1
        errs = doc.get("errors", [])
        if errs and not doc.get("items"):
            raise RuntimeError("; ".join(errs)[:300])
        return "%d важных из %d новых" % (sent, len(doc.get("items", [])))

    def job_digest(self, now):
        text, total = self._total()
        record_history(self.pack, now, "close")
        code, out, err = self.pack.log_today()
        halted = self.pack.halted()
        day = self.pack.read("trader/state/day.json", {}) or {}
        result = ""
        if day.get("date") == now.date().isoformat() and day.get("start_total"):
            start = float(day["start_total"])
            diff = total - start
            result = "Результат дня: <b>%s%s ₽ (%+.2f%%)</b> от %s ₽ на старте" % (
                "+" if diff >= 0 else "", "{:,.0f}".format(diff).replace(",", " "),
                100.0 * diff / start if start else 0.0, "{:,.0f}".format(start).replace(",", " "))
        msg = ["<b>Итог дня</b> %s" % now.date().isoformat()] + ([result] if result else []) + [
               text, "<b>Решения</b>", "<pre>%s</pre>" % html(out.strip()[:1500] or "нет")]
        if halted:
            msg.append("⛔ Стоп-кран включён: %s" % html(halted.get("reason", "")))
        self.notify("\n".join(msg))
        return "отправлен"

    # ------------------------------------------------------------ status
    def status_line(self):
        parts = []
        for j in self.jobs:
            last = self.last.get(j["name"])
            parts.append("%s %s" % (j["name"], "–" if (last is None or j["name"] in self.skipped) else last.strftime("%H:%M")))
        return ", ".join(parts) + (", рынок открыт" if self.market_open() else ", рынок закрыт")

    def status_text(self):
        lines = ["<b>Планировщик</b> (%s)" % ("рынок открыт" if self.market_open() else "рынок закрыт")]
        for j in self.jobs:
            when = ("каждые %s мин" % j["every_min"]) if j.get("every_min") else ("в %s" % j.get("at"))
            if j.get("market_hours_only"):
                when += ", в торговые часы"
            last = self.last.get(j["name"])
            if j["name"] in self.skipped:
                last = None
            lines.append("• %s: %s. Последний запуск %s. %s" % (
                j["name"], when, last.strftime("%d.%m %H:%M") if last else "ещё не было",
                html(self.last_result.get(j["name"], ""))))
        return "\n".join(lines)
