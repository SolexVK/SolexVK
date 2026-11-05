"""The Telegram bot: commands, compact views and the two-click order approval.

Rules that do not bend:
  - only user ids from the config are heard; everyone else gets nothing
  - an order is sent only from a button press by an allowed user, never by the
    scheduler, and only through tinvest.py order (which checks its own gates)
  - two presses per order: "Подтвердить" shows the exact ticket again, then
    "Да, отправить" records the yes (ticket.py approve, with who pressed it)
    and sends it. "Отклонить" records a no.
  - the kill switch (/stop) blocks sending until /resume
"""

import datetime
import json
import re

from .tg import html, button


HELP = """<b>Команды</b>
/status – среда, счёт, стоп-кран, последние задачи
/portfolio – позиции и кэш (обновляет из брокера)
/quotes [тикеры] – цены (по умолчанию по портфелю)
/propose [бюджет] – предложить ордера по целям (trader-budget)
/rebalance [полоса] – ордера ребалансировки
/risk – проверить предложенные ордера по лимитам
/orders – тикеты с кнопками подтверждения
/alerts – проверить ценовые алерты сейчас
/news [тикеры] – новости по бумагам и рынку (новое с прошлого раза)
/metrics [тикеры|all] – фундаментальные показатели в metrics.json
/screen – отбор по правилам из metrics.json
/index [IMOEX] [N] [-ТИКЕР...] – скопировать индекс в цели
/log – решения за сегодня
/panel – ссылка на веб-панель
/jobs – планировщик
/stop [причина] – стоп-кран: ничего не отправлять
/resume – снять стоп-кран

Один ордер за раз, два нажатия на каждый. Это не инвестиционная рекомендация."""


def money(x, cur="RUB"):
    s = "{:,.2f}".format(float(x)).replace(",", " ")
    s = s[:-3] if s.endswith(".00") else s
    return "$" + s if cur == "USD" else "%s %s" % (s, cur)


def portfolio_view(pack):
    """Compact table from trader/portfolio.json and trader/prices.json."""
    cfg = pack.config()
    cur = cfg.get("currency", "RUB")
    pf = pack.read("trader/portfolio.json", {}) or {}
    prices = (pack.read("trader/prices.json", {}) or {}).get("prices", {})
    cash = float(pf.get("cash", 0))
    rows, total = [], cash
    for p in pf.get("positions", []):
        t = str(p.get("ticker", "")).upper()
        sh = float(p.get("shares", 0))
        px = prices.get(t)
        if px is None:
            cost = sum(float(l.get("cost", 0)) for l in p.get("lots", []))
            val, px_s = cost, "?"
        else:
            val, px_s = sh * float(px), "%.2f" % float(px)
        total += val
        rows.append((t, sh, px_s, val))
    lines = ["%-7s %9s %9s %12s %5s" % ("тикер", "шт", "цена", "стоимость", "%")]
    for t, sh, px_s, val in sorted(rows, key=lambda r: -r[3]):
        share = (100.0 * val / total) if total else 0
        lines.append("%-7s %9s %9s %12s %4.0f%%" % (t, ("%.4f" % sh).rstrip("0").rstrip("."), px_s,
                                                    "{:,.0f}".format(val).replace(",", " "), share))
    lines.append("%-7s %9s %9s %12s %4.0f%%" % ("кэш", "", "", "{:,.0f}".format(cash).replace(",", " "),
                                                (100.0 * cash / total) if total else 0))
    head = "<b>Портфель</b> %s, итого <b>%s</b>%s" % (
        pf.get("source", ""), money(total, cur),
        (", цены на " + str((pack.read("trader/prices.json", {}) or {}).get("as_of", ""))[:16]) if prices else "")
    return head + "\n<pre>" + html("\n".join(lines)) + "</pre>", total


def ticket_view(t, cfg):
    env = "ПЕСОЧНИЦА" if cfg.get("paper", True) else "РЕАЛЬНЫЙ СЧЁТ"
    mark = "🟢" if t.get("ready") else ("🔴" if "BLOCK" in t.get("status", "") else "⚪")
    lines = ["%s <b>Ордер #%d</b>  %s" % (mark, t["index"], env), html(t.get("plain", "")),
             "<i>%s</i>" % html(t.get("status", ""))]
    for w in t.get("warnings", []) or []:
        lines.append("⚠ " + html(w))
    return "\n".join(lines)


def fp8(t):
    return str(t.get("fingerprint", ""))[:8]


class Bot(object):
    def __init__(self, tg, pack, cfg, scheduler=None, panel=None, clock=None):
        self.tg, self.pack, self.cfg, self.scheduler, self.panel = tg, pack, cfg, scheduler, panel
        self.allowed = {int(x) for x in (cfg.get("telegram", {}).get("allowed_user_ids") or [])}
        self.clock = clock or datetime.datetime.now

    # ------------------------------------------------------------ dispatch
    def handle(self, update):
        if "message" in update:
            return self.on_message(update["message"])
        if "callback_query" in update:
            return self.on_callback(update["callback_query"])
        return None

    def allowed_user(self, user):
        return bool(user) and int(user.get("id", 0)) in self.allowed

    def on_message(self, msg):
        user, chat = msg.get("from") or {}, msg.get("chat") or {}
        text = (msg.get("text") or "").strip()
        if not self.allowed_user(user):
            if not self.allowed and text.startswith("/start"):
                self.tg.send(chat["id"], "Ваш Telegram id: <code>%s</code>.\nВпишите его в service/config.json "
                                         "в allowed_user_ids и перезапустите сервис." % user.get("id"))
            return "ignored"
        if not text.startswith("/"):
            self.tg.send(chat["id"], "Я понимаю только команды. /help")
            return "text"
        parts = text.split()
        cmd = parts[0].split("@")[0].lower()
        args = parts[1:]
        fn = getattr(self, "cmd_" + cmd[1:], None)
        if not fn:
            self.tg.send(chat["id"], "Не знаю такой команды. /help")
            return "unknown"
        try:
            fn(chat["id"], args, user)
        except Exception as exc:  # the bot must not die on one bad command
            self.tg.send(chat["id"], "Ошибка: <pre>%s</pre>" % html(str(exc)[:1500]))
        return cmd

    # ------------------------------------------------------------ commands
    def cmd_start(self, chat, args, user):
        self.tg.send(chat, "Привет. Это ваш торговый ассистент.\n\n" + HELP)

    def cmd_help(self, chat, args, user):
        self.tg.send(chat, HELP)

    def cmd_status(self, chat, args, user):
        cfg = self.pack.config()
        halted = self.pack.halted()
        prices = self.pack.read("trader/prices.json", {}) or {}
        lines = ["<b>Статус</b>",
                 "Среда: <b>%s</b>, брокер %s, счёт %s" % ("песочница" if cfg.get("paper", True) else "РЕАЛЬНЫЙ СЧЁТ",
                                                             cfg.get("broker", "?"), cfg.get("account_id") or "не задан"),
                 "Стоп-кран: %s" % (("<b>ВКЛЮЧЁН</b> (%s, %s)" % (html(halted.get("reason", "")), halted.get("at")))
                                    if halted else "выключен"),
                 "Цены: %s (%s)" % (str(prices.get("as_of", "нет"))[:16], prices.get("source", ""))]
        if self.scheduler:
            lines.append("Планировщик: " + self.scheduler.status_line())
        code, out, err = self.pack.log_today()
        lines.append("Сегодня: " + html(out.strip().splitlines()[-1] if out.strip() else "решений нет"))
        self.tg.send(chat, "\n".join(lines))

    def cmd_portfolio(self, chat, args, user):
        code, out, err = self.pack.portfolio()
        if code != 0:
            self.tg.send(chat, "Не удалось получить портфель:\n<pre>%s</pre>" % html((err or out).strip()[:1500]))
            return
        text, total = portfolio_view(self.pack)
        self.tg.send(chat, text)

    def cmd_quotes(self, chat, args, user):
        tickers = [a.upper() for a in args if re.match(r"^[A-Za-z][A-Za-z0-9.\-]{0,6}$", a)]
        code, out, err = self.pack.quote(tickers)
        self.tg.send(chat, "<pre>%s</pre>" % html((out + err).strip()[:3000] or "пусто"))

    def cmd_propose(self, chat, args, user):
        budget = args[0] if args and re.match(r"^\d+(\.\d+)?$", args[0]) else None
        taken = self.pack.take_inbox_targets()
        note = ("Взяты новые цели из inbox (%s).\n" % html(taken)) if taken else ""
        targets = self.pack.read("trader/targets.json", {}) or {}
        if targets.get("why"):
            note += "<i>%s</i>\n" % html(str(targets["why"])[:600])
        code, out, err = self.pack.size(budget)
        self.tg.send(chat, "%s<b>trader-budget</b>\n<pre>%s</pre>\n%s" % (
            note, html((out + err).strip()[:3000]), "Дальше: /risk" if code == 0 else "Ошибка, см. выше."))

    def cmd_rebalance(self, chat, args, user):
        band = args[0] if args and re.match(r"^\d+(\.\d+)?$", args[0]) else None
        code, out, err = self.pack.rebalance(band)
        self.tg.send(chat, "<b>trader-rebalance</b>\n<pre>%s</pre>\n%s" % (
            html((out + err).strip()[:3000]), "Дальше: /risk" if code == 0 else "Ошибка, см. выше."))

    def cmd_risk(self, chat, args, user):
        try:
            code, res, err = self.pack.risk()
        except Exception as exc:
            self.tg.send(chat, "trader-risk: <pre>%s</pre>" % html(str(exc)[:1500]))
            return
        lines = ["<b>Риск-менеджер</b>: %d PASS, %d BLOCK" % (res.get("pass", 0), res.get("block", 0))]
        for w in res.get("warnings", []):
            lines.append("⚠ " + html(w))
        for r in res.get("results", []):
            lines.append("%s #%d %s %s %s" % ("🟢" if r["verdict"] == "PASS" else "🔴", r["index"],
                                               r["side"], r["symbol"], html(r.get("amount", ""))))
            for x in r.get("reasons", []):
                lines.append("   • " + html(x))
        lines.append("Дальше: /orders" if res.get("pass") else "Ничего не прошло. Поправьте ордера или лимиты.")
        self.tg.send(chat, "\n".join(lines))

    def cmd_orders(self, chat, args, user):
        cfg = self.pack.config()
        try:
            tickets = self.pack.tickets()
        except Exception as exc:
            self.tg.send(chat, "Нет тикетов: <pre>%s</pre>\nСначала /propose или /rebalance, потом /risk." % html(str(exc)[:800]))
            return
        ready = 0
        for t in tickets:
            buttons = None
            if t.get("ready"):
                ready += 1
                buttons = [[button("✅ Подтвердить #%d" % t["index"], "ok:%d:%s" % (t["index"], fp8(t))),
                            button("❌ Отклонить #%d" % t["index"], "no:%d:%s" % (t["index"], fp8(t)))]]
            self.tg.send(chat, ticket_view(t, cfg), buttons)
        if not ready:
            self.tg.send(chat, "Готовых к отправке ордеров нет.")

    def cmd_alerts(self, chat, args, user):
        res = self.pack.alerts_check()
        rings = res.get("rings", [])
        lines = ["<b>Алерты</b>"] + ["🔔 " + html(r["message"]) for r in rings]
        if not rings:
            lines.append("Ничего не сработало.")
        for e in res.get("errors", []):
            lines.append("⚠ " + html(e))
        self.tg.send(chat, "\n".join(lines))

    def cmd_news(self, chat, args, user):
        tickers = [a.upper() for a in args if re.match(r"^[A-Za-z][A-Za-z0-9.\-]{0,6}$", a)]
        doc = self.pack.news(tickers)
        items = doc.get("items", [])
        lines = ["<b>Новости</b> (%s)" % html(", ".join(doc.get("watch", [])) or "рынок")]
        offset = datetime.timedelta(hours=float(self.cfg.get("timezone_offset_hours", 3)))
        for it in items[:15]:
            who = ",".join(it.get("touches", [])) or "рынок"
            when = ""
            if it.get("time"):
                try:
                    when = (datetime.datetime.fromisoformat(it["time"]) + offset).strftime("%d.%m %H:%M")
                except ValueError:
                    when = it["time"][11:16]
            mark = "❗" if it.get("important") else "•"
            lines.append('%s <b>%s</b> %s <a href="%s">%s</a>' % (mark, html(who), when, html(it.get("link", "")),
                                                                   html(it.get("title", ""))))
            if it.get("tags"):
                lines.append("   <i>%s</i>" % html(", ".join(it["tags"])))
        if not items:
            lines.append("Ничего нового.")
        for e in doc.get("errors", []):
            lines.append("⚠ " + html(e))
        self.tg.send(chat, "\n".join(lines))

    def cmd_metrics(self, chat, args, user):
        tickers = [a.upper() for a in args if re.match(r"^[A-Za-z][A-Za-z0-9.\-]{0,6}$", a) and a.lower() != "all"]
        all_shares = any(a.lower() == "all" for a in args)
        if not tickers and not all_shares:
            pf = self.pack.read("trader/portfolio.json", {}) or {}
            tickers = [str(p.get("ticker", "")).upper() for p in pf.get("positions", []) if p.get("ticker")]
        if not tickers and not all_shares:
            self.tg.send(chat, "Укажите тикеры или all: /metrics SBER LKOH, /metrics all")
            return
        self.tg.send(chat, "Считаю показатели%s..." % (" по всем бумагам, это минута-две" if all_shares else ""))
        code, out, err = self.pack.metrics(tickers, all_shares)
        self.tg.send(chat, "<pre>%s</pre>\n%s" % (html((out + err).strip()[:3500]),
                                                   "Дальше: /screen" if code == 0 else "Ошибка, см. выше."))

    def cmd_screen(self, chat, args, user):
        code, out, err = self.pack.screen()
        self.tg.send(chat, "<b>Отбор</b>\n<pre>%s</pre>" % html((out + err).strip()[:3500]))

    def cmd_index(self, chat, args, user):
        index = next((a.upper() for a in args if re.match(r"^[A-Za-z]{3,8}$", a) and not a.startswith("-")), "IMOEX")
        top = next((a for a in args if re.match(r"^\d{1,3}$", a)), None)
        exclude = [a[1:].upper() for a in args if a.startswith("-") and len(a) > 1]
        code, out, err = self.pack.index_copy(index, top, exclude)
        if code != 0:
            self.tg.send(chat, "<pre>%s</pre>" % html((out + err).strip()[:2000]))
            return
        targets = self.pack.read("trader/targets.json", {}) or {}
        tickers = [w.get("ticker") for w in targets.get("weights", []) if w.get("ticker")]
        qcode, qout, qerr = self.pack.quote(tickers)
        self.tg.send(chat, "<pre>%s</pre>\nЦены для целей:\n<pre>%s</pre>\n%s" % (
            html(out.strip()[:2500]), html((qout + qerr).strip()[:1200]),
            "Дальше: /propose или /rebalance, потом /risk" if qcode == 0 else "Цены получены не все, см. выше."))

    def cmd_log(self, chat, args, user):
        code, out, err = self.pack.log_today()
        self.tg.send(chat, "<pre>%s</pre>" % html((out + err).strip()[:3500] or "пусто"))

    def cmd_panel(self, chat, args, user):
        if not self.panel:
            self.tg.send(chat, "Панель выключена: задайте web.secret в service/config.json (docs/dashboard.md).")
            return
        self.tg.send(chat, 'Панель: <a href="%s">открыть</a>\nСсылка содержит секрет, никому её не пересылайте.' % html(self.panel.url()))

    def cmd_jobs(self, chat, args, user):
        self.tg.send(chat, self.scheduler.status_text() if self.scheduler else "Планировщик не запущен.")

    def cmd_stop(self, chat, args, user):
        doc = self.pack.halt(" ".join(args) or "по команде /stop", "telegram:%s" % user.get("id"))
        self.tg.send(chat, "⛔ Стоп-кран включён (%s). Ордера не отправляются до /resume." % html(doc["reason"]))

    def cmd_resume(self, chat, args, user):
        self.tg.send(chat, "Стоп-кран снят." if self.pack.resume() else "Стоп-кран и так выключен.")

    # ------------------------------------------------------------ buttons
    def on_callback(self, cq):
        user = cq.get("from") or {}
        msg = cq.get("message") or {}
        chat, mid = (msg.get("chat") or {}).get("id"), msg.get("message_id")
        data = cq.get("data") or ""
        if not self.allowed_user(user):
            return "ignored"
        m = re.match(r"^(ok|no|go|x):(\d+)(?::([0-9a-f]{8}))?$", data)
        if not m:
            self.tg.answer(cq["id"], "Непонятная кнопка")
            return "bad"
        action, index, fp = m.group(1), int(m.group(2)), m.group(3) or ""
        try:
            return self._act(action, index, fp, cq, chat, mid, user)
        except Exception as exc:
            self.tg.answer(cq["id"], "Ошибка")
            self.tg.edit(chat, mid, "Ошибка: <pre>%s</pre>" % html(str(exc)[:1500]))
            return "error"

    def _fresh(self, index, fp, cq, chat, mid):
        """The ticket as it is right now; None (and a message) if it is not the one on the button."""
        t = self.pack.ticket(index)
        if fp8(t) != fp:
            self.tg.answer(cq["id"], "Ордер изменился")
            self.tg.edit(chat, mid, "Ордер #%d изменился с тех пор, как показана эта кнопка. /orders заново." % index)
            return None
        if not t.get("ready"):
            self.tg.answer(cq["id"], "Не готов")
            self.tg.edit(chat, mid, ticket_view(t, self.pack.config()) + "\nБольше не готов к отправке.")
            return None
        return t

    def _act(self, action, index, fp, cq, chat, mid, user):
        cfg = self.pack.config()
        if action == "x":
            self.tg.answer(cq["id"], "Отменено")
            self.tg.edit(chat, mid, "Ордер #%d: отправка отменена, решение не записано. /orders покажет его снова." % index)
            return "cancel"
        t = self._fresh(index, fp, cq, chat, mid)
        if t is None:
            return "stale"
        if action == "no":
            self.pack.decline(index, "нет (кнопка Telegram, %s)" % user.get("id"))
            self.tg.answer(cq["id"], "Отклонён")
            self.tg.edit(chat, mid, ticket_view(t, cfg) + "\n❌ Отклонён вами. Ничего не отправлено.")
            return "declined"
        if action == "ok":
            self.tg.answer(cq["id"])
            self.tg.edit(chat, mid, ticket_view(t, cfg) + "\n\n<b>Отправить этот ордер брокеру?</b> (%s)" %
                         ("песочница" if cfg.get("paper", True) else "РЕАЛЬНЫЕ ДЕНЬГИ"),
                         [[button("🚀 Да, отправить #%d" % index, "go:%d:%s" % (index, fp)),
                           button("Отмена", "x:%d" % index)]])
            return "confirm"
        # action == "go": the yes, recorded with who pressed it, then one order
        halted = self.pack.halted()
        if halted:
            self.tg.answer(cq["id"], "Стоп-кран включён", alert=True)
            self.tg.edit(chat, mid, ticket_view(t, cfg) + "\n⛔ Стоп-кран включён (%s). /resume, потом /orders."
                         % html(halted.get("reason", "")))
            return "halted"
        via = "telegram:%s:%s" % (user.get("id"), cq.get("id"))
        sym = str(t.get("plain", "")).split(" of ")[-1].split(",")[0].strip() if " of " in t.get("plain", "") else ""
        reply = ("да %s" % sym).strip()
        code, out, err = self.pack.approve(index, reply, via)
        if code != 0:
            self.tg.answer(cq["id"], "Не записано")
            self.tg.edit(chat, mid, ticket_view(t, cfg) + "\nНе записано: <pre>%s</pre>" % html((out + err).strip()[:800]))
            return "not-recorded"
        self.tg.answer(cq["id"], "Отправляю")
        self.tg.edit(chat, mid, ticket_view(t, cfg) + "\n✅ Да записано (%s). Отправляю брокеру..." % html(via))
        code, out, err = self.pack.place(index)
        res = (out + err).strip()
        mark = "📨 Отправлен" if code == 0 else "⚠ Не отправлен"
        self.tg.edit(chat, mid, ticket_view(t, cfg) + "\n%s\n<pre>%s</pre>" % (mark, html(res[:2500])))
        return "placed" if code == 0 else "failed"
