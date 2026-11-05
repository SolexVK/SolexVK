import json
import os
import shutil
import tempfile
import unittest

import _path  # noqa: F401
from service.bot import Bot
from service.pack import Pack
from service.tg import html, Telegram

ROOT = _path.ROOT
TODAY = "2026-11-04"
ME = {"id": 111, "first_name": "Solex"}
STRANGER = {"id": 999}


class FakeTg(object):
    def __init__(self):
        self.sent, self.edited, self.answered = [], [], []

    def send(self, chat_id, text, buttons=None, silent=False):
        self.sent.append((chat_id, text, buttons))
        return {"message_id": len(self.sent)}

    def edit(self, chat_id, message_id, text, buttons=None):
        self.edited.append((chat_id, message_id, text, buttons))

    def answer(self, callback_id, text=None, alert=False):
        self.answered.append((callback_id, text, alert))


def msg(text, user=ME):
    return {"message": {"from": user, "chat": {"id": user["id"]}, "text": text}}


def click(data, user=ME, mid=5, cbid="cb1"):
    return {"callback_query": {"id": cbid, "from": user, "data": data,
                               "message": {"message_id": mid, "chat": {"id": user["id"]}}}}


class BotFlow(unittest.TestCase):
    """Real pack scripts in a temp project; only the broker call is faked."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dir, "trader", "state"))
        with open(os.path.join(ROOT, "trader-skill", "trader-tinvest", "config.example.json")) as fh:
            cfg = json.load(fh)
        cfg["account_id"] = "sb1"
        self.w("trader/config.json", cfg)
        self.w("trader/prices.json", {"as_of": TODAY + "T10:00:00Z", "prices": {"SBER": 310.5, "LKOH": 7000}})
        self.w("trader/orders.json", {"orders": [
            {"symbol": "SBER", "side": "buy", "notional": "9500", "type": "market", "time_in_force": "day"},
            {"symbol": "LKOH", "side": "buy", "notional": "7000", "type": "market", "time_in_force": "day"}]})
        self.pack = Pack(self.dir, os.path.join(ROOT, "trader-skill"))
        self.placed = []
        self.pack.place = lambda index: (self.placed.append(index) or (0, "Placed. Broker order id ord-%d" % index, ""))
        self.tg = FakeTg()
        self.bot = Bot(self.tg, self.pack, {"telegram": {"allowed_user_ids": [111]}})
        os.environ["TINVEST_SANDBOX_TOKEN"] = "t.test"

    def tearDown(self):
        shutil.rmtree(self.dir)

    def w(self, rel, doc):
        with open(os.path.join(self.dir, rel), "w") as fh:
            json.dump(doc, fh)

    def r(self, rel):
        with open(os.path.join(self.dir, rel)) as fh:
            return json.load(fh)

    def test_strangers_get_nothing(self):
        self.assertEqual(self.bot.handle(msg("/status", STRANGER)), "ignored")
        self.assertEqual(self.bot.handle(click("go:1:deadbeef", STRANGER)), "ignored")
        self.assertEqual(self.tg.sent, [])
        self.assertEqual(self.tg.edited, [])

    def test_empty_allowlist_only_tells_the_id(self):
        bot = Bot(self.tg, self.pack, {"telegram": {"allowed_user_ids": []}})
        bot.handle(msg("/start", STRANGER))
        self.assertIn("999", self.tg.sent[0][1])
        bot.handle(msg("/orders", STRANGER))
        self.assertEqual(len(self.tg.sent), 1)

    def test_two_clicks_place_one_order_once(self):
        self.bot.handle(msg("/risk"))
        self.assertIn("2 PASS, 0 BLOCK", self.tg.sent[-1][1])
        self.bot.handle(msg("/orders"))
        with_buttons = [s for s in self.tg.sent if s[2]]
        self.assertEqual(len(with_buttons), 2)
        data = with_buttons[0][2][0][0]["callback_data"]
        self.assertTrue(data.startswith("ok:1:"))
        fp = data.split(":")[2]
        # first click: shows the confirmation, records nothing, sends nothing
        self.assertEqual(self.bot.handle(click("ok:1:" + fp)), "confirm")
        self.assertIn("Отправить этот ордер", self.tg.edited[-1][2])
        self.assertEqual(self.tg.edited[-1][3][0][0]["callback_data"], "go:1:" + fp)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "trader/state/broker.json")))
        self.assertEqual(self.placed, [])
        # second click: the yes is recorded with who pressed it, then one broker call
        self.assertEqual(self.bot.handle(click("go:1:" + fp, cbid="cb77")), "placed")
        state = self.r("trader/state/broker.json")
        rec = state["orders"][0]
        self.assertEqual((rec["status"], rec["symbol"], rec["via"]), ("approved", "SBER", "telegram:111:cb77"))
        self.assertEqual(rec["reply"], "да SBER")
        self.assertEqual(self.placed, [1])
        self.assertIn("Отправлен", self.tg.edited[-1][2])
        # the same button again does not send twice
        self.assertEqual(self.bot.handle(click("go:1:" + fp)), "stale")
        self.assertEqual(self.placed, [1])
        # order 2 is untouched and still ready
        self.assertTrue(self.pack.ticket(2)["ready"])

    def test_stale_fingerprint_is_refused(self):
        self.bot.handle(msg("/risk"))
        self.assertEqual(self.bot.handle(click("go:1:00000000")), "stale")
        self.assertIn("изменился", self.tg.edited[-1][2])
        self.assertEqual(self.placed, [])

    def test_decline_and_cancel(self):
        self.bot.handle(msg("/risk"))
        fp = self.pack.ticket(2)["fingerprint"][:8]
        self.assertEqual(self.bot.handle(click("x:2")), "cancel")
        self.assertFalse(os.path.exists(os.path.join(self.dir, "trader/state/broker.json")))
        self.assertEqual(self.bot.handle(click("no:2:" + fp)), "declined")
        self.assertEqual(self.r("trader/state/broker.json")["orders"][-1]["status"], "declined")
        self.assertFalse(self.pack.ticket(2)["ready"])
        self.assertEqual(self.placed, [])

    def test_kill_switch_blocks_sending(self):
        self.bot.handle(msg("/risk"))
        fp = self.pack.ticket(1)["fingerprint"][:8]
        self.bot.handle(msg("/stop рынок штормит"))
        self.assertTrue(self.pack.halted())
        self.assertEqual(self.bot.handle(click("go:1:" + fp)), "halted")
        self.assertEqual(self.placed, [])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "trader/state/broker.json")))
        self.bot.handle(msg("/resume"))
        self.assertFalse(self.pack.halted())
        self.assertEqual(self.bot.handle(click("go:1:" + fp)), "placed")

    def test_propose_takes_targets_from_inbox(self):
        os.makedirs(os.path.join(self.dir, "trader", "inbox"))
        self.w("trader/targets.json", {"weights": {"SBER": 100}})
        self.w("trader/inbox/targets.json", {"weights": {"SBER": 50, "LKOH": 50}, "source": "sirius",
                                              "why": "две бумаги вместо одной"})
        self.bot.handle(msg("/propose"))
        text = self.tg.sent[-1][1]
        self.assertIn("Взяты новые цели из inbox (sirius)", text)
        self.assertIn("две бумаги вместо одной", text)
        self.assertIn("LKOH", text)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "trader/inbox/targets.json")))
        self.assertEqual(self.r("trader/targets.prev.json")["weights"], {"SBER": 100})
        self.assertEqual(self.r("trader/targets.json")["source"], "sirius")
        # a bad inbox file is reported, not swallowed
        self.w("trader/inbox/targets.json", {"oops": 1})
        self.bot.handle(msg("/propose"))
        self.assertIn("is not a targets file", self.tg.sent[-1][1])

    def test_news_metrics_screen_index_commands(self):
        fix = os.path.join(ROOT, "trader-skill", "tests", "fixtures", "trader-moex")
        real_run = self.pack.run

        def offline_run(skill, name, *args, **kw):
            if name == "moex_news.py":
                args = list(args) + ["--offline", fix, "--now", "2026-11-05T06:00:00Z", "--hours", "72"]
            if name == "moex_index.py":
                args = list(args) + ["--offline", fix]
            return real_run(skill, name, *args, **kw)
        self.pack.run = offline_run
        self.pack.quote = lambda tickers=(): (0, "quoted %s" % " ".join(tickers), "")
        self.w("trader/portfolio.json", {"cash": 1, "positions": [{"ticker": "SBER", "shares": 85}, {"ticker": "LKOH", "shares": 4}]})
        self.bot.handle(msg("/news"))
        text = self.tg.sent[-1][1]
        self.assertIn("Новости", text)
        self.assertIn("LKOH", text)
        self.assertIn('href="https://www.finam.ru', text)
        self.bot.handle(msg("/index IMOEX 3 -GAZP"))
        text = self.tg.sent[-1][1]
        self.assertIn("top 3 by weight, excluding GAZP", text)
        self.assertIn("quoted LKOH SBER YDEX", text)
        self.assertEqual([w["ticker"] for w in self.r("trader/targets.json")["weights"]], ["LKOH", "SBER", "YDEX"])
        os.environ.pop("TINVEST_SANDBOX_TOKEN", None)  # no token: the script must refuse before any network
        self.bot.handle(msg("/metrics"))
        self.assertIn("Считаю показатели", self.tg.sent[-2][1])
        self.assertIn("no token", self.tg.sent[-1][1])
        self.w("trader/metrics.json", {"companies": [{"ticker": "SBER", "eps_ttm": 70, "pe": 4, "dividend_yield": 11, "net_debt_to_ebitda": 0.5}]})
        self.bot.handle(msg("/screen"))
        self.assertIn("SBER", self.tg.sent[-1][1])

    def test_status_and_unknown_command(self):
        self.bot.handle(msg("/status"))
        self.assertIn("песочница", self.tg.sent[-1][1])
        self.bot.handle(msg("/nonsense"))
        self.assertIn("/help", self.tg.sent[-1][1])
        self.bot.handle(msg("привет"))
        self.assertIn("команды", self.tg.sent[-1][1])

    def test_panel_button(self):
        class P(object):
            def https(self): return True
            def url(self): return "https://trade.example.ru/d/secret"
        bot = Bot(self.tg, self.pack, {"telegram": {"allowed_user_ids": [111]}}, None, P())
        bot.handle(msg("/panel"))
        self.assertEqual(self.tg.sent[-1][2][0][0]["web_app"]["url"], "https://trade.example.ru/d/secret")
        bot = Bot(self.tg, self.pack, {"telegram": {"allowed_user_ids": [111]}}, None, None)
        bot.handle(msg("/panel"))
        self.assertIn("выключена", self.tg.sent[-1][1])

    def test_html_escape(self):
        self.assertEqual(html("a<b>&"), "a&lt;b&gt;&amp;")


class Relay(unittest.TestCase):
    def test_default_and_relay_base(self):
        tg = Telegram(token="1:x", transport=lambda m, p, t: {"ok": True, "result": {}})
        self.assertEqual(tg.url("getMe"), "https://api.telegram.org/bot1:x/getMe")
        self.assertFalse(tg.relayed)
        self.assertEqual(sorted(tg.allowed), ["api.telegram.org"])
        tg = Telegram(token="1:x", base="https://tg-relay.me.workers.dev/", relay_key="k",
                      transport=lambda m, p, t: {"ok": True, "result": {}})
        self.assertEqual(tg.url("getMe"), "https://tg-relay.me.workers.dev/bot1:x/getMe")
        self.assertTrue(tg.relayed)
        self.assertIn("tg-relay.me.workers.dev", tg.allowed)
        from service.tg import TgError
        with self.assertRaises(TgError):
            Telegram(token="1:x", base="http://plain.example", transport=lambda m, p, t: {})

    def test_every_method_builds_its_payload(self):
        calls = []

        def transport(method, payload, timeout):
            calls.append((method, payload, timeout))
            return {"ok": True, "result": [{"update_id": 7, "message": {}}] if method == "getUpdates" else {}}
        tg = Telegram(token="1:x", transport=transport)
        self.assertEqual(len(tg.updates()), 1)
        self.assertEqual(tg.offset, 8)
        self.assertEqual(calls[-1][1]["timeout"], 50)
        self.assertEqual(calls[-1][2], 60)
        tg.updates(timeout=5)
        self.assertEqual(calls[-1][1]["offset"], 8)
        tg.send(1, "hi", [[{"text": "b", "callback_data": "d"}]])
        self.assertEqual(calls[-1][1]["reply_markup"]["inline_keyboard"][0][0]["callback_data"], "d")
        tg.edit(1, 2, "x")
        self.assertEqual(calls[-1][0], "editMessageText")
        tg.answer("cb", "ok")
        self.assertEqual(calls[-1][1]["callback_query_id"], "cb")
        tg.set_commands([("help", "h")])
        self.assertEqual(calls[-1][1]["commands"][0]["command"], "help")
        tg.get_me()
        self.assertEqual(calls[-1][1], {})

    def test_token_never_in_errors(self):
        from service.tg import TgError
        tg = Telegram(token="1:secret", transport=lambda m, p, t: {"ok": False, "description": "bad 1:secret"})
        try:
            tg.get_me()
        except TgError as exc:
            self.assertNotIn("secret", str(exc))


if __name__ == "__main__":
    unittest.main()
