import datetime
import json
import unittest

import _path  # noqa: F401
from service.scheduler import Scheduler

TZ = datetime.timezone(datetime.timedelta(hours=3))


def at(day, hhmm):  # 2026-11-04 is a Wednesday
    h, m = hhmm.split(":")
    return datetime.datetime(2026, 11, day, int(h), int(m), tzinfo=TZ)


class FakePack(object):
    def __init__(self):
        self.files = {"trader/config.json": {"currency": "RUB", "paper": True},
                      "trader/portfolio.json": {"cash": 1000.0, "positions": [{"ticker": "SBER", "shares": 30, "lots": []}]},
                      "trader/prices.json": {"as_of": "x", "prices": {"SBER": 300.0}}}
        self.calls = []
        self.rings = []

    def config(self):
        return self.files["trader/config.json"]

    def read(self, rel, default=None):
        return self.files.get(rel, default)

    def write(self, rel, doc):
        self.files[rel] = doc

    def path(self, rel):
        import os, tempfile
        base = getattr(self, "_tmp", None) or tempfile.mkdtemp()
        self._tmp = base
        p = os.path.join(base, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p

    def quote(self, tickers=()):
        self.calls.append("quote")
        return 0, "ok", ""

    def portfolio(self):
        self.calls.append("portfolio")
        return 0, "ok", ""

    def alerts_check(self):
        self.calls.append("alerts")
        return {"rings": list(self.rings), "errors": []}

    def news(self, tickers=(), only_mine=False, state=None):
        self.calls.append("news")
        assert only_mine and state == "trader/state/moex_news_job.json"
        return {"items": [{"touches": ["SBER"], "important": True, "title": "Сбер отчитался", "link": "https://x/1", "tags": ["отчётность"]},
                          {"touches": ["SBER"], "important": False, "title": "мелочь", "link": "https://x/2", "tags": []}],
                "errors": [], "watch": ["SBER"]}

    def schedule(self):
        self.calls.append("schedule")
        self.files["trader/state/schedule.json"] = {"exchange": "MOEX", "days": {
            "2026-11-04": {"trading": False},
            "2026-11-05": {"trading": True, "start": "2026-11-05T06:59:00Z", "end": "2026-11-05T15:50:00Z"}}}
        return 0, "ok", ""

    def log_today(self):
        return 0, "1 placed today.", ""

    def halted(self):
        return self.files.get("trader/state/halt.json")

    def halt(self, reason, by):
        self.files["trader/state/halt.json"] = {"reason": reason, "by": by}

    def place(self, index):  # pragma: no cover
        raise AssertionError("the scheduler must never place an order")


CFG = {"timezone_offset_hours": 3, "max_daily_loss_pct": 3,
       "market_hours": {"open": "10:00", "close": "18:50", "days": [0, 1, 2, 3, 4]},
       "jobs": [{"name": "schedule", "at": "09:30"},
                {"name": "quotes", "every_min": 15, "market_hours_only": True},
                {"name": "alerts", "every_min": 5, "market_hours_only": True},
                {"name": "guard", "every_min": 10, "market_hours_only": True},
                {"name": "news", "every_min": 60, "market_hours_only": True},
                {"name": "snapshot", "at": "09:55", "days": [0, 1, 2, 3, 4]},
                {"name": "digest", "at": "18:55", "days": [0, 1, 2, 3, 4]}]}


class Clock(object):
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


class SchedulerTests(unittest.TestCase):
    def make(self, t):
        self.pack = FakePack()
        self.notes = []
        self.clock = Clock(t)
        return Scheduler(self.pack, self.notes.append, CFG, clock=self.clock)

    def test_market_hours(self):
        s = self.make(at(4, "12:00"))
        self.assertTrue(s.market_open(at(4, "10:00")))
        self.assertFalse(s.market_open(at(4, "09:59")))
        self.assertFalse(s.market_open(at(4, "18:50")))
        self.assertFalse(s.market_open(at(7, "12:00")))  # Saturday

    def test_calendar_from_the_exchange(self):
        s = self.make(at(4, "12:00"))
        self.assertTrue(s.market_open(at(4, "12:00")))      # no calendar yet: config hours say open
        self.assertEqual(s.tick(), ["schedule", "quotes", "alerts", "guard", "news"])
        self.assertEqual(len([n for n in self.notes if "Сбер отчитался" in n]), 1)  # only the important one
        self.assertFalse(s.market_open(at(4, "12:00")))     # calendar: Nov 4 is a holiday
        self.assertTrue(s.market_open(at(5, "10:00")))      # 07:00 UTC is inside 06:59..15:50
        self.assertFalse(s.market_open(at(5, "18:51")))     # 15:51 UTC is after the close
        s.clock.t = at(4, "12:30")
        self.assertEqual(s.tick(), [])                      # closed by the calendar: nothing runs
        self.assertEqual(self.pack.calls.count("schedule"), 1)

    def test_nothing_fires_outside_market_hours_except_at_jobs(self):
        s = self.make(at(4, "08:00"))
        self.pack.schedule()  # calendar present so the config hours are not consulted
        self.assertEqual(s.due(), [])
        s.clock.t = at(4, "09:55")
        self.assertEqual(sorted(s.tick()), ["schedule", "snapshot"])  # the 09:30 calendar job and the snapshot
        with open(self.pack.path("trader/state/history.jsonl")) as fh:
            rows = [json.loads(l) for l in fh if l.strip()]
        self.assertEqual((rows[-1]["label"], rows[-1]["total"]), ("open", 10000.0))
        self.assertEqual(self.pack.files["trader/state/day.json"]["start_total"], 10000.0)
        s.clock.t = at(4, "09:56")
        self.assertEqual(s.tick(), [])  # once a day

    def test_at_job_already_passed_does_not_fire_at_startup(self):
        s = self.make(at(4, "19:30"))
        self.pack.schedule()
        self.assertEqual(s.due(), [])
        self.assertIn("время уже прошло", s.status_text())
        s.clock.t = at(5, "10:00")  # the next day the marker is gone and the 18:55 job is simply pending
        self.assertNotIn("время уже прошло", s.status_text())
        self.assertIn("digest –", s.status_line())
        s.clock.t = at(5, "18:55")
        self.assertIn("digest", s.tick())
        self.assertEqual(self.notes, [])

    def test_every_jobs_and_cadence(self):
        s = self.make(at(5, "10:00"))
        self.pack.schedule()
        self.assertEqual(sorted(s.tick()), ["alerts", "guard", "news", "quotes"])
        self.assertIn("quote", self.pack.calls)
        s.clock.t = at(5, "10:05")
        self.assertEqual(s.tick(), ["alerts"])
        s.clock.t = at(5, "10:10")
        self.assertEqual(sorted(s.tick()), ["alerts", "guard"])
        s.clock.t = at(5, "10:15")
        self.assertEqual(sorted(s.tick()), ["alerts", "quotes"])

    def test_alert_rings_are_sent(self):
        s = self.make(at(5, "10:00"))
        self.pack.schedule()
        self.pack.rings = [{"id": "x", "symbol": "SBER", "message": "SBER is at 320"}]
        s.tick()
        self.assertTrue(any("SBER is at 320" in n for n in self.notes))

    def test_guard_pulls_the_kill_switch(self):
        s = self.make(at(5, "10:00"))
        self.pack.schedule()
        s.tick()  # guard with no snapshot takes one
        self.assertEqual(self.pack.files["trader/state/day.json"]["start_total"], 10000.0)
        self.pack.files["trader/prices.json"]["prices"]["SBER"] = 289.0  # 30 shares: 9670 total, -3.3%
        s.clock.t = at(5, "10:10")
        s.tick()
        self.assertTrue(self.pack.halted())
        self.assertIn("дневной убыток", self.pack.halted()["reason"])
        self.assertTrue(any("Стоп-кран" in n for n in self.notes))
        self.assertEqual(len([n for n in self.notes if "Стоп-кран" in n]), 1)
        s.clock.t = at(5, "10:20")
        s.tick()  # already halted: no second message
        self.assertEqual(len([n for n in self.notes if "Стоп-кран" in n]), 1)

    def test_guard_quiet_within_the_limit(self):
        s = self.make(at(5, "10:00"))
        self.pack.schedule()
        s.tick()
        self.pack.files["trader/prices.json"]["prices"]["SBER"] = 295.0  # -1.5%
        s.clock.t = at(5, "10:10")
        s.tick()
        self.assertFalse(self.pack.halted())
        self.assertFalse(any("Стоп-кран" in n for n in self.notes))

    def test_digest_and_errors_throttled(self):
        s = self.make(at(4, "18:40"))
        self.pack.schedule()
        self.pack.files["trader/state/day.json"] = {"date": "2026-11-04", "start_total": 9800.0}
        s.clock.t = at(4, "18:55")
        self.assertEqual(s.tick(), ["digest"])
        self.assertIn("Итог дня", self.notes[-1])
        self.assertIn("Результат дня: <b>+200 ₽ (+2.04%)</b>", self.notes[-1])
        self.pack.quote = lambda tickers=(): (1, "", "boom")
        s.clock.t = at(5, "10:00")
        s.tick()
        s.clock.t = at(5, "10:15")
        s.tick()
        self.assertEqual(len([n for n in self.notes if "boom" in n]), 1)
        self.assertIn("quotes", s.status_text())


if __name__ == "__main__":
    unittest.main()
