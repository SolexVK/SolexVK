import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from _load import load, ROOT

tinvest = load("trader-tinvest", "tinvest")
check = load("trader-risk", "check")
ticket = load("trader-broker", "ticket")

TODAY = "2026-11-04"
SBER = {"uid": "u-sber", "figi": "BBG004730N88", "ticker": "SBER", "classCode": "TQBR", "lot": 10,
        "currency": "rub", "apiTradeAvailableFlag": True, "forQualInvestorFlag": False, "instrumentType": "share"}


class Fake(object):
    """Stands in for tinvest.call: records every request, answers from a script."""

    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def __call__(self, env, method, body, token, timeout=30):
        self.calls.append((env, method, body))
        if token != "t.sandbox" and env == "sandbox":
            raise tinvest.TinvestError("bad token")
        a = self.answers.get(method)
        if callable(a):
            return a(body)
        if a is None:
            raise tinvest.TinvestError("%s: HTTP 404 no fake answer" % method)
        return a


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = tinvest.main(argv)
    return code, out.getvalue(), err.getvalue()


class Money(unittest.TestCase):
    def test_quotation_round_trip(self):
        self.assertEqual(tinvest.q2f({"units": "310", "nano": 500000000}), 310.5)
        self.assertEqual(tinvest.q2f({"units": "-1", "nano": -250000000}), -1.25)
        self.assertEqual(tinvest.f2q(310.5), {"units": "310", "nano": 500000000})
        self.assertEqual(tinvest.f2q(100000, "RUB"), {"units": "100000", "nano": 0, "currency": "RUB"})
        self.assertEqual(tinvest.q2f(tinvest.f2q(0.123456789)), 0.123456789)

    def test_lots(self):
        self.assertEqual(tinvest.lots_for({"qty": "25"}, SBER, 300.0), (2, 10))
        self.assertEqual(tinvest.lots_for({"notional": "9500"}, SBER, 310.5), (3, 10))
        with self.assertRaises(tinvest.TinvestError):
            tinvest.lots_for({"notional": "1000"}, SBER, 310.5)
        with self.assertRaises(tinvest.TinvestError):
            tinvest.lots_for({"notional": "1000"}, SBER, None)

    def test_order_body(self):
        o = {"symbol": "SBER", "side": "buy", "qty": "30", "type": "market", "time_in_force": "day"}
        b = tinvest.order_body(o, SBER, "acc", 3, "idem")
        self.assertEqual(b, {"accountId": "acc", "instrumentId": "u-sber", "quantity": "3",
                             "direction": "ORDER_DIRECTION_BUY", "orderType": "ORDER_TYPE_MARKET", "orderId": "idem"})
        lim = dict(o, side="sell", type="limit", limit_price="320.1")
        b = tinvest.order_body(lim, SBER, "acc", 1, "idem")
        self.assertEqual(b["orderType"], "ORDER_TYPE_LIMIT")
        self.assertEqual(b["price"], {"units": "320", "nano": 100000000})
        self.assertEqual(b["timeInForce"], "TIME_IN_FORCE_DAY")
        with self.assertRaises(tinvest.TinvestError):
            tinvest.order_body(dict(o, type="stop", stop_price="1"), SBER, "acc", 1, "idem")
        with self.assertRaises(tinvest.TinvestError):
            tinvest.order_body(dict(o, time_in_force="gtc"), SBER, "acc", 1, "idem")


class Environment(unittest.TestCase):
    def test_paper_means_sandbox(self):
        self.assertEqual(tinvest.env_from({}), "sandbox")
        self.assertEqual(tinvest.env_from({"paper": True}), "sandbox")
        self.assertEqual(tinvest.env_from({"paper": False}), "prod")
        self.assertEqual(tinvest.env_from({"paper": True}, "prod"), "prod")  # read-only override
        with self.assertRaises(tinvest.TinvestError):
            tinvest.env_from({"paper": True}, "prod", for_order=True)

    def test_token_never_from_the_wrong_variable(self):
        old = dict(os.environ)
        try:
            os.environ.pop("TINVEST_TOKEN", None)
            os.environ["TINVEST_SANDBOX_TOKEN"] = "t.sandbox"
            self.assertEqual(tinvest.token_for("sandbox"), "t.sandbox")
            with self.assertRaises(tinvest.TinvestError):
                tinvest.token_for("prod")
        finally:
            os.environ.clear()
            os.environ.update(old)


class Flow(unittest.TestCase):
    """config -> orders -> check.py -> ticket.py approve -> tinvest.py order, all offline."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cwd = os.getcwd()
        os.chdir(self.dir)
        os.makedirs("trader/state")
        self.old_env = dict(os.environ)
        os.environ["TINVEST_SANDBOX_TOKEN"] = "t.sandbox"
        os.environ.pop("TINVEST_TOKEN", None)
        os.environ.pop("TINVEST_LIVE", None)
        with open(os.path.join(ROOT, "trader-tinvest", "config.example.json")) as fh:
            cfg = json.load(fh)
        cfg["account_id"] = "sb1"
        self.cfg = cfg
        self.write("trader/config.json", cfg)
        self.write("trader/prices.json", {"as_of": TODAY + "T10:00:00Z", "prices": {"SBER": 310.5}})
        self.write("trader/orders.json", {"orders": [
            {"symbol": "SBER", "side": "buy", "notional": "9500", "type": "market", "time_in_force": "day"},
            {"symbol": "SBER", "side": "sell", "qty": "10", "type": "limit", "limit_price": "330",
             "time_in_force": "day"}]})
        self.fake = Fake({
            "SandboxService/GetSandboxAccounts": {"accounts": [
                {"id": "sb1", "type": "ACCOUNT_TYPE_TINKOFF", "status": "ACCOUNT_STATUS_OPEN",
                 "accessLevel": "ACCOUNT_ACCESS_LEVEL_FULL_ACCESS", "name": "robot"}]},
            "InstrumentsService/GetInstrumentBy": {"instrument": SBER},
            "MarketDataService/GetLastPrices": {"lastPrices": [
                {"instrumentUid": "u-sber", "price": {"units": "310", "nano": 500000000}, "time": "2026-11-04T10:00:00Z"}]},
            "SandboxService/PostSandboxOrder": {"orderId": "ord-1", "executionReportStatus": "EXECUTION_REPORT_STATUS_FILL",
                                                "lotsRequested": "3", "lotsExecuted": "3",
                                                "executedOrderPrice": {"currency": "rub", "units": "310", "nano": 400000000},
                                                "executedCommission": {"currency": "rub", "units": "4", "nano": 660000000}},
            "InstrumentsService/TradingSchedules": {"exchanges": [{"exchange": "MOEX", "days": [
                {"date": "2026-11-04T00:00:00Z", "isTradingDay": False},
                {"date": "2026-11-05T00:00:00Z", "isTradingDay": True, "startTime": "2026-11-05T06:59:00Z",
                 "endTime": "2026-11-05T15:50:00Z", "eveningStartTime": "2026-11-05T16:05:00Z",
                 "eveningEndTime": "2026-11-05T20:50:00Z"}]}]},
            "SandboxService/GetSandboxPortfolio": {"totalAmountPortfolio": {"currency": "rub", "units": "100000", "nano": 0},
                                                   "totalAmountCurrencies": {"currency": "rub", "units": "90685", "nano": 0},
                                                   "positions": [
                {"instrumentType": "currency", "ticker": "RUB000UTSTOM", "quantity": {"units": "90685", "nano": 0}},
                {"instrumentType": "share", "ticker": "SBER", "instrumentUid": "u-sber",
                 "quantity": {"units": "30", "nano": 0},
                 "averagePositionPrice": {"currency": "rub", "units": "310", "nano": 400000000},
                 "currentPrice": {"currency": "rub", "units": "312", "nano": 0}}]},
        })
        self.real_call = tinvest.call
        tinvest.call = self.fake

    def tearDown(self):
        tinvest.call = self.real_call
        os.chdir(self.cwd)
        shutil.rmtree(self.dir)
        os.environ.clear()
        os.environ.update(self.old_env)

    def write(self, path, data):
        with open(path, "w") as fh:
            json.dump(data, fh)

    def read(self, path):
        with open(path) as fh:
            return json.load(fh)

    def risk_and_yes(self, index=1, reply="да"):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(out):
            check.main(["--today", TODAY])
            code = ticket.main(["approve", "--index", str(index), "--reply", reply, "--today", TODAY])
        return code, out.getvalue()

    def test_refuses_without_risk_pass_or_yes(self):
        code, out, err = run(["order", "--index", "1", "--today", TODAY])
        self.assertEqual(code, 1)
        self.assertIn("trader-risk has not checked", err)
        self.assertEqual(self.fake.calls, [])  # no network before the gates
        with redirect_stdout(io.StringIO()):
            check.main(["--today", TODAY])
        code, out, err = run(["order", "--index", "1", "--today", TODAY])
        self.assertEqual(code, 1)
        self.assertIn("no yes recorded", err)
        self.assertEqual(self.fake.calls, [])

    def test_places_one_sandbox_order_and_records_the_fill(self):
        code, log = self.risk_and_yes()
        self.assertEqual(code, 0, log)
        code, out, err = run(["order", "--index", "1", "--today", TODAY])
        self.assertEqual(code, 0, err)
        self.assertIn("BUY 3 lots of SBER (30 shares)", out)
        self.assertIn("SANDBOX", out)
        envs = {c[0] for c in self.fake.calls}
        self.assertEqual(envs, {"sandbox"})
        post = [c for c in self.fake.calls if c[1] == "SandboxService/PostSandboxOrder"]
        self.assertEqual(len(post), 1)
        body = post[0][2]
        self.assertEqual(body["quantity"], "3")
        self.assertEqual(body["direction"], "ORDER_DIRECTION_BUY")
        self.assertEqual(body["instrumentId"], "u-sber")
        self.assertEqual(len(body["orderId"]), 36)
        state = self.read("trader/state/broker.json")
        last = state["orders"][-1]
        self.assertEqual((last["status"], last["broker_order_id"], last["lots"], last["lots_executed"], last["env"]),
                         ("placed", "ord-1", 3, 3, "sandbox"))
        pf = self.read("trader/portfolio.json")
        self.assertEqual(pf["positions"][0]["ticker"], "SBER")
        self.assertEqual(pf["positions"][0]["shares"], 30.0)
        self.assertAlmostEqual(pf["cash"], 100000 - 30 * 310.4 - 4.66, places=2)  # commission included
        self.assertAlmostEqual(pf["positions"][0]["lots"][0]["cost"], 30 * 310.4 + 4.66, places=2)
        self.assertEqual(last["fee"], 4.66)
        self.assertIn("commission 4.66 RUB", out)
        # the same yes cannot be sent twice
        code, out, err = run(["order", "--index", "1", "--today", TODAY])
        self.assertEqual(code, 1)
        self.assertIn("already has a result", err)
        self.assertEqual(len([c for c in self.fake.calls if "PostSandboxOrder" in c[1]]), 1)

    def test_dry_run_sends_nothing(self):
        self.risk_and_yes()
        code, out, err = run(["order", "--index", "1", "--today", TODAY, "--dry-run"])
        self.assertEqual(code, 0, err)
        self.assertIn("dry run, nothing sent", out)
        self.assertFalse(any("PostSandboxOrder" in c[1] for c in self.fake.calls))
        self.assertFalse(os.path.exists("trader/state/broker.json") and
                         any(r["status"] == "placed" for r in self.read("trader/state/broker.json")["orders"]))

    def test_live_needs_the_config_and_the_env_opt_in(self):
        self.risk_and_yes()
        self.cfg["paper"] = False
        self.write("trader/config.json", self.cfg)
        os.environ["TINVEST_TOKEN"] = "t.prod"
        code, out, err = run(["order", "--index", "1", "--today", TODAY])
        self.assertEqual(code, 1)
        self.assertIn("LIVE", err)
        self.assertIn("TINVEST_LIVE", err)
        self.assertEqual(self.fake.calls, [])
        # and --env cannot push an order to the other environment
        self.cfg["paper"] = True
        self.write("trader/config.json", self.cfg)
        code, out, err = run(["order", "--index", "1", "--today", TODAY, "--env", "prod"])
        self.assertEqual(code, 1)
        self.assertIn("cannot override", err)
        self.assertEqual(self.fake.calls, [])

    def test_wrong_broker_in_config_refuses(self):
        self.risk_and_yes()
        self.cfg["broker"] = "alpaca"
        self.write("trader/config.json", self.cfg)
        code, out, err = run(["order", "--index", "1", "--today", TODAY])
        self.assertEqual(code, 1)
        self.assertIn('"broker": "tinvest"', err)
        self.assertEqual(self.fake.calls, [])

    def test_refusal_after_the_yes_is_recorded_as_failed(self):
        self.risk_and_yes()
        self.fake.answers["InstrumentsService/GetInstrumentBy"] = {"instrument": dict(SBER, apiTradeAvailableFlag=False)}
        code, out, err = run(["order", "--index", "1", "--today", TODAY])
        self.assertEqual(code, 1)
        self.assertIn("cannot be traded", err)
        last = self.read("trader/state/broker.json")["orders"][-1]
        self.assertEqual(last["status"], "failed")
        self.assertIn("cannot be traded", last["note"])
        self.assertFalse(any("PostSandboxOrder" in c[1] for c in self.fake.calls))
        # and the quote marks it, so the next risk check blocks it before any yes
        code, out, err = run(["quote", "SBER", "--write"])
        self.assertIn("NOT TRADABLE VIA API", out)
        self.assertIs(self.read("trader/prices.json")["detail"]["SBER"]["api_trade"], False)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            check.main(["--today", TODAY])
        self.assertEqual(self.read("trader/state/risk.json")["results"][0]["verdict"], "BLOCK")

    def test_read_only_token_cannot_place(self):
        self.risk_and_yes()
        self.fake.answers["SandboxService/GetSandboxAccounts"]["accounts"][0]["accessLevel"] = "ACCOUNT_ACCESS_LEVEL_READ_ONLY"
        code, out, err = run(["order", "--index", "1", "--today", TODAY])
        self.assertEqual(code, 1)
        self.assertIn("full-access", err)
        self.assertFalse(any("PostSandboxOrder" in c[1] for c in self.fake.calls))

    def test_quote_writes_prices_in_the_pack_format(self):
        code, out, err = run(["quote", "SBER", "--write"])
        self.assertEqual(code, 0, err)
        doc = self.read("trader/prices.json")
        self.assertEqual(doc["prices"]["SBER"], 310.5)
        self.assertEqual(doc["detail"]["SBER"]["lot"], 10)
        self.assertEqual(doc["source"], "tinvest-sandbox")
        self.assertTrue(doc["as_of"].endswith("Z"))

    def test_portfolio_writes_cash_and_positions(self):
        code, out, err = run(["portfolio", "--write"])
        self.assertEqual(code, 0, err)
        pf = self.read("trader/portfolio.json")
        self.assertEqual(pf["cash"], 90685.0)
        self.assertEqual(pf["positions"][0]["ticker"], "SBER")
        self.assertEqual(pf["positions"][0]["shares"], 30.0)
        self.assertAlmostEqual(pf["positions"][0]["lots"][0]["cost"], 30 * 310.4, places=2)
        self.assertIn("90,685 RUB", out)

    def test_schedule_writes_the_calendar(self):
        code, out, err = run(["schedule", "--write", "--days", "3"])
        self.assertEqual(code, 0, err)
        self.assertIn("2026-11-04  closed", out)
        self.assertIn("2026-11-05  trading  06:59 .. 15:50 UTC", out)
        doc = self.read("trader/state/schedule.json")
        self.assertEqual(doc["exchange"], "MOEX")
        self.assertFalse(doc["days"]["2026-11-04"]["trading"])
        self.assertEqual(doc["days"]["2026-11-05"]["end"], "2026-11-05T15:50:00Z")
        body = [c for c in self.fake.calls if c[1].endswith("TradingSchedules")][0][2]
        self.assertEqual(body["exchange"], "MOEX")
        self.assertTrue(body["from"].endswith("T00:00:00Z"))

    def test_whoami_and_sandbox_payin(self):
        self.fake.answers["SandboxService/SandboxPayIn"] = {"balance": {"currency": "rub", "units": "100000", "nano": 0}}
        code, out, err = run(["whoami"])
        self.assertEqual(code, 0, err)
        self.assertIn("sandbox", out)
        self.assertIn("sb1", out)
        self.assertNotIn("t.sandbox", out + err)  # the token is never printed
        code, out, err = run(["sandbox", "payin", "100000"])
        self.assertEqual(code, 0, err)
        body = [c for c in self.fake.calls if c[1] == "SandboxService/SandboxPayIn"][0][2]
        self.assertEqual(body, {"accountId": "sb1", "amount": {"units": "100000", "nano": 0, "currency": "RUB"}})


if __name__ == "__main__":
    unittest.main()
