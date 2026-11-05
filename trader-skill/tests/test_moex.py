"""The MOEX editions of analyst, news and copycat: offline, on fixtures and a fake API."""
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

from _load import load, FIX

facts = load("trader-analyst", "moex_facts")
news = load("trader-news", "moex_news")
index = load("trader-copycat", "moex_index")
tinvest = load("trader-tinvest", "tinvest")
DIR = os.path.join(FIX, "trader-moex")
NOW = "2026-11-05T06:00:00Z"


def run(mod, argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = mod.main(argv)
    return code, out.getvalue(), err.getvalue()


class InTemp(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cwd = os.getcwd()
        os.chdir(self.dir)
        os.makedirs("trader/state")

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.dir)

    def write(self, rel, doc):
        with open(rel, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False)

    def read(self, rel):
        with open(rel, encoding="utf-8") as fh:
            return json.load(fh)


SBER = {"uid": "u-sber", "assetUid": "a-sber", "ticker": "SBER", "classCode": "TQBR", "lot": 10, "name": "Сбер Банк",
        "sector": "financial", "currency": "rub", "countryOfRisk": "RU", "apiTradeAvailableFlag": True}
LKOH = dict(SBER, uid="u-lkoh", assetUid="a-lkoh", ticker="LKOH", name="ЛУКОЙЛ", sector="energy", lot=1)
FOREIGN = dict(SBER, uid="u-x", assetUid="a-x", ticker="XXXX", countryOfRisk="US")
FUND_SBER = {"assetUid": "a-sber", "currency": "RUB", "revenueTtm": 4200000000000.0, "netIncomeTtm": 1600000000000.0,
             "epsTtm": 72.5, "peRatioTtm": 4.1, "priceToBookTtm": 0.9, "evToEbitdaMrq": 0, "roe": 24.3,
             "netMarginMrq": 38.1, "dividendYieldDailyTtm": 11.6, "oneYearAnnualRevenueGrowthRate": 12.5,
             "netDebtToEbitda": None, "marketCapitalization": 6.5e12, "fiscalPeriodEndDate": "2026-06-30T00:00:00Z"}
FUND_LKOH = {"assetUid": "a-lkoh", "currency": "RUB", "revenueTtm": 8.0e12, "netIncomeTtm": 1.1e12, "epsTtm": 1600.0,
             "peRatioTtm": 3.8, "dividendYieldDailyTtm": 14.0, "fiscalPeriodEndDate": "2026-06-30T00:00:00Z"}


class Fundamentals(InTemp):
    def setUp(self):
        super().setUp()
        self.old_env = dict(os.environ)
        os.environ["TINVEST_SANDBOX_TOKEN"] = "t.sandbox"
        self.calls = []

        def fake(env, method, body, token, timeout=30):
            self.calls.append((method, body))
            if method == "InstrumentsService/GetInstrumentBy":
                return {"instrument": {"SBER": SBER, "LKOH": LKOH}.get(body["id"], {})}
            if method == "InstrumentsService/Shares":
                return {"instruments": [SBER, LKOH, FOREIGN, dict(SBER, ticker="SBERP", classCode="TQBR", apiTradeAvailableFlag=False)]}
            if method == "InstrumentsService/GetAssetFundamentals":
                return {"fundamentals": [f for f in (FUND_SBER, FUND_LKOH) if f["assetUid"] in body["assets"]]}
            if method == "InstrumentsService/GetDividends":
                return {"dividends": [{"dividendNet": {"currency": "rub", "units": "34", "nano": 840000000},
                                       "recordDate": "2026-07-18T00:00:00Z"}]}
            raise AssertionError(method)
        self.real = tinvest.call
        tinvest.call = fake
        facts.load_tinvest = lambda: tinvest

    def tearDown(self):
        tinvest.call = self.real
        os.environ.clear()
        os.environ.update(self.old_env)
        super().tearDown()

    def test_row_mapping(self):
        row = facts.metrics_row(SBER, FUND_SBER)
        self.assertEqual((row["ticker"], row["name"], row["sector"], row["period_end"]), ("SBER", "Сбер Банк", "financial", "2026-06-30"))
        self.assertEqual(row["eps_ttm"], 72.5)
        self.assertEqual(row["pe"], 4.1)
        self.assertEqual(row["dividend_yield"], 11.6)
        self.assertEqual(row["revenue_growth_yoy"], 12.5)
        self.assertIsNone(row["ev_ebitda"])          # the API's 0 means "no data"
        self.assertIsNone(row["net_debt_to_ebitda"])
        self.assertEqual(row["source"], "T-Invest GetAssetFundamentals")

    def test_tickers_to_metrics_file(self):
        code, out, err = run(facts, ["SBER", "LKOH"])
        self.assertEqual(code, 0, err)
        self.assertIn("SBER", out)
        self.assertIn("4.20 трлн", out)
        doc = self.read("trader/metrics.json")
        self.assertEqual([c["ticker"] for c in doc["companies"]], ["LKOH", "SBER"])
        self.assertEqual(doc["companies"][1]["pe"], 4.1)
        # the screener reads it as is
        screen = load("trader-screener", "screen")
        self.write("rules.json", {"rules": [{"metric": "pe", "op": "<=", "value": 4.0}], "rank": [], "missing": "fail"})
        code, sout, serr = run(screen, ["trader/metrics.json", "--rules", "rules.json", "--json"])
        passed = [r["ticker"] for r in json.loads(sout)["passed"]] if "passed" in sout else sout
        self.assertEqual(passed, ["LKOH"])

    def test_all_filters_to_russian_tradable_shares(self):
        code, out, err = run(facts, ["--all", "--no-write", "--json"])
        self.assertEqual(code, 0, err)
        doc = json.loads(out)
        self.assertEqual([c["ticker"] for c in doc["companies"]], ["LKOH", "SBER"])
        shares_call = [c for c in self.calls if c[0] == "InstrumentsService/Shares"]
        self.assertEqual(len(shares_call), 1)

    def test_dividends_listed(self):
        code, out, err = run(facts, ["SBER", "--dividends", "--no-write"])
        self.assertIn("SBER dividends (2 years): 34.84 rub on 2026-07-18", out)

    def test_no_token_no_network(self):
        os.environ.pop("TINVEST_SANDBOX_TOKEN")
        code, out, err = run(facts, ["SBER"])
        self.assertEqual(code, 1)
        self.assertIn("no token", err)
        self.assertEqual(self.calls, [])


class News(InTemp):
    def setUp(self):
        super().setUp()
        self.write("trader/portfolio.json", {"cash": 1, "positions": [{"ticker": "SBER", "shares": 85},
                                                                      {"ticker": "LKOH", "shares": 4},
                                                                      {"ticker": "GAZP", "shares": 160}]})

    def test_feed_parsing_unescapes_and_times(self):
        mod = news.load_news_module()
        with open(os.path.join(DIR, "moex.xml"), "rb") as fh:
            items = news.parse_feed(fh.read(), "Мосбиржа", mod.parse_time)
        self.assertTrue(items)
        self.assertTrue(all(it["time"] is not None for it in items))
        self.assertFalse(any("&quot;" in it["title"] for it in items))

    def test_aliases_match_russian_case_endings(self):
        aliases = news.load_aliases()
        pats = news.mention_patterns({"SBER": None, "LKOH": "ЛУКОЙЛ", "GAZP": None, "T": None}, aliases)
        self.assertTrue(pats["SBER"].search("Акции Сбербанка выросли"))
        self.assertTrue(pats["SBER"].search("Сбер отчитался"))
        self.assertTrue(pats["LKOH"].search("по активам «ЛУКОЙЛа»"))
        self.assertTrue(pats["GAZP"].search("«Газпром» обновил рекорд"))
        self.assertTrue(pats["T"].search("Т-Банк запустил"))
        self.assertFalse(pats["T"].search("Трамп заявил"))       # the bare ticker T is not a word prefix
        self.assertFalse(pats["GAZP"].search("Газпромбанк"))     # another company, not a case ending
        self.assertTrue(pats["GAZP"].search("акции Газпрома и Газпромом"))

    def test_run_shows_mine_and_market_once(self):
        code, out, err = run(news, ["--offline", DIR, "--now", NOW, "--hours", "72"])
        self.assertEqual(code, 0, err)
        self.assertIn("LKOH", out)
        self.assertIn("GAZP", out)
        self.assertIn("рынок", out)
        self.assertIn("теги: сделка", out)
        self.assertNotIn("Узбекистана", out.split("ЦБ Узбекистана")[0][-200:] if "ЦБ Узбекистана" in out else "")
        self.assertTrue(os.path.exists("trader/state/moex_news.json"))
        code, out2, err = run(news, ["--offline", DIR, "--now", "2026-11-05T06:30:00Z", "--hours", "72"])
        self.assertEqual(code, 1)
        self.assertIn("Ничего нового", out2)
        code, out3, err = run(news, ["--offline", DIR, "--now", NOW, "--hours", "72", "--all", "--only-mine", "--json"])
        doc = json.loads(out3)
        self.assertTrue(all(it["touches"] for it in doc["items"]))
        self.assertEqual(doc["watch"], ["GAZP", "LKOH", "SBER"])

    def test_foreign_central_bank_is_not_the_rate_tag(self):
        items = [{"title": "ЦБ Узбекистана снова сохранил основную ставку", "summary": "", "ticker": ""},
                 {"title": "ЦБ сохранил ключевую ставку", "summary": "", "ticker": ""},
                 {"title": "Россияне стали больше жаловаться в ЦБ", "summary": "", "ticker": ""},
                 {"title": "Индекс Мосбиржи открылся снижением", "summary": "", "ticker": ""}]
        news.tag(items, {}, {})
        self.assertNotIn("ставка", items[0]["tags"])
        self.assertIn("ставка", items[1]["tags"])
        self.assertTrue(items[1]["market"])          # the key rate is market-wide
        self.assertIn("ставка", items[2]["tags"])
        self.assertFalse(items[2]["market"])         # a mention of the central bank is not
        self.assertTrue(items[3]["market"])


class Index(InTemp):
    def test_list_and_copy(self):
        rows = index.composition("IMOEX", DIR)
        self.assertEqual(rows[0]["ticker"], "LKOH")
        self.assertEqual(len(rows), 44)
        self.assertAlmostEqual(sum(r["weight"] for r in rows), 100.0, delta=0.5)
        w = index.copy_weights(rows, top=3)
        self.assertEqual([x["ticker"] for x in w], ["LKOH", "SBER", "GAZP"])
        self.assertAlmostEqual(sum(x["weight"] for x in w), 100.0, places=2)
        w = index.copy_weights(rows, min_weight=5, exclude=["LKOH"])
        self.assertNotIn("LKOH", [x["ticker"] for x in w])
        self.assertTrue(all(x["index_weight"] >= 5 for x in w))
        with self.assertRaises(index.IndexError_):
            index.copy_weights(rows, min_weight=99)

    def test_copy_writes_targets_the_budget_reads(self):
        code, out, err = run(index, ["copy", "--top", "5", "--exclude", "GAZP", "--offline", DIR])
        self.assertEqual(code, 0, err)
        doc = self.read("trader/targets.json")
        self.assertEqual(doc["index"], "IMOEX")
        self.assertEqual([w["ticker"] for w in doc["weights"]], ["LKOH", "SBER", "YDEX", "TATN", "T"])
        self.assertIn("why", doc)
        size = load("trader-budget", "size")
        self.assertEqual(len(size.parse_weights(doc)), 5)
        code, out, err = run(index, ["list", "--index", "NOPE", "--offline", DIR])
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
