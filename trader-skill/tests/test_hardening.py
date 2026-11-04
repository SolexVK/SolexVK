"""The audit items fixed on top of the upstream pack, pinned."""
import json
import os
import ssl
import unittest
import urllib.request

from _load import load, ROOT

check = load("trader-risk", "check")
ticket = load("trader-broker", "ticket")
ptr = load("trader-pelosi", "ptr")
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("common_net", os.path.join(ROOT, "common", "net.py"))
net = importlib.util.module_from_spec(spec)
spec.loader.exec_module(net)

TODAY = "2026-10-13"
PRICES = {"AAPL": 341.27, "KO": 90.11}


def cfg(**over):
    with open(os.path.join(ROOT, "trader-budget", "config.example.json")) as fh:
        c = json.load(fh)
    c.update(over)
    return c


def buy(sym, usd):
    return {"symbol": sym, "side": "buy", "notional": str(usd), "type": "market", "time_in_force": "day"}


class RiskLimits(unittest.TestCase):
    def test_zero_is_zero_not_unlimited(self):
        res = check.check([buy("AAPL", 100)], cfg(max_position_pct=0), None, PRICES, None, TODAY)
        self.assertEqual(res["results"][0]["verdict"], "BLOCK")
        self.assertIn("position", res["results"][0]["reasons"][0])
        res = check.check([buy("AAPL", 100)], cfg(max_order_usd=0), None, PRICES, None, TODAY)
        self.assertIn("size", " ".join(res["results"][0]["reasons"]))
        res = check.check([buy("AAPL", 100)], cfg(max_orders_per_day=0), None, PRICES, None, TODAY)
        self.assertIn("daily limit", " ".join(res["results"][0]["reasons"]))

    def test_null_means_no_limit(self):
        res = check.check([buy("AAPL", 100)], cfg(max_position_pct=None, max_order_usd=None,
                                                   max_orders_per_day=None), None, PRICES, None, TODAY)
        self.assertEqual(res["results"][0]["verdict"], "PASS")

    def test_approved_counts_as_sent_and_side_case_does_not_matter(self):
        state = {"orders": [{"date": TODAY, "symbol": "aapl", "side": "Buy", "status": "approved"}]}
        res = check.check([buy("AAPL", 100)], cfg(), None, PRICES, state, TODAY)
        self.assertIn("already placed today", " ".join(res["results"][0]["reasons"]))
        state = {"orders": [{"date": TODAY, "symbol": "KO", "side": "buy", "status": "approved"}] * 10}
        res = check.check([buy("AAPL", 100)], cfg(max_orders_per_day=10), None, PRICES, state, TODAY)
        self.assertIn("daily limit", " ".join(res["results"][0]["reasons"]))

    def test_broker_flags_block_before_the_yes(self):
        detail = {"TMOS": {"api_trade": False}, "AAPL": {"qual_only": True}, "KO": {"api_trade": True}}
        res = check.check([buy("TMOS", 100), buy("AAPL", 100), buy("KO", 100)], cfg(),
                          None, dict(PRICES, TMOS=6.15), None, TODAY, detail=detail)
        self.assertEqual(check.verdicts(res) if hasattr(check, "verdicts") else
                         [r["verdict"] for r in res["results"]], ["BLOCK", "BLOCK", "PASS"])
        self.assertIn("not tradable through the API", res["results"][0]["reasons"][0])
        self.assertIn("qualified investors", res["results"][1]["reasons"][0])
        res = check.check([buy("AAPL", 100)], cfg(allow_qual_only=True), None, PRICES, None, TODAY, detail=detail)
        self.assertEqual(res["results"][0]["verdict"], "PASS")

    def test_moex_tickers_pass_the_format_check(self):
        for sym in ("SBER", "X5", "LKOH", "T", "YDEX", "BRK.B"):
            self.assertTrue(check.TICKER.match(sym), sym)
        for sym in ("BTC/USD", "sber", "TOOLONGX", "1ABC"):
            self.assertFalse(check.TICKER.match(sym), sym)


class ExplicitYes(unittest.TestCase):
    AAPL = {"symbol": "AAPL", "side": "buy", "notional": "1250", "type": "market", "time_in_force": "day"}

    def yes(self, reply, batch=("AAPL", "KO")):
        return ticket.parse_yes(reply, self.AAPL, batch)[0]

    def test_a_ticker_outside_the_batch_is_refused_too(self):
        self.assertFalse(self.yes("yes TSLA"))
        self.assertFalse(self.yes("yes, but SBER"))
        self.assertTrue(self.yes("yes AAPL"))
        self.assertTrue(self.yes("Yes, buy it"))
        self.assertTrue(self.yes("YES"))
        self.assertTrue(self.yes("yes 1250 USD"))

    def test_russian_yes(self):
        self.assertTrue(self.yes("да"))
        self.assertTrue(self.yes("Да, покупай"))
        self.assertTrue(self.yes("да AAPL 1250"))
        for r in ("да на все", "да, все", "да всех", "да, но", "да, подожди", "нет", "да если упадёт",
                  "ок", "давай", "да?", "да KO"):
            self.assertFalse(self.yes(r), r)


class Currency(unittest.TestCase):
    def tearDown(self):
        ticket.set_currency("USD")

    def test_rub_formatting(self):
        ticket.set_currency("RUB")
        self.assertEqual(ticket._money(9315), "9,315 ₽")
        self.assertEqual(ticket.plain({"symbol": "SBER", "side": "buy", "notional": "9500"}),
                         "BUY 9,500 ₽ of SBER, market order, good for today")
        ticket.set_currency("USD")
        self.assertEqual(ticket._money(1250), "$1,250")


class PtrDocIds(unittest.TestCase):
    def test_only_numbers_become_paths(self):
        for ok in ("20035143", "1"):
            self.assertTrue(ptr.valid_doc_id(ok))
        for bad in ("../../x", "/etc/passwd", "20035143.pdf", "", None, "2003 5143"):
            self.assertFalse(ptr.valid_doc_id(bad))
        with self.assertRaises(ptr.PtrError):
            ptr._fetch_and_read("../x", 2026, "nowhere")

    def test_malformed_index_rows_are_dropped(self):
        xml = (b'<FinancialDisclosure><Member><Prefix/><Last>Doe</Last><First>J</First><Suffix/>'
               b'<FilingType>P</FilingType><StateDst>CA11</StateDst><Year>2026</Year>'
               b'<FilingDate>1/2/2026</FilingDate><DocID>../../evil</DocID></Member>'
               b'<Member><Prefix/><Last>Roe</Last><First>R</First><Suffix/><FilingType>P</FilingType>'
               b'<StateDst>CA11</StateDst><Year>2026</Year><FilingDate>1/2/2026</FilingDate>'
               b'<DocID>20099999</DocID></Member></FinancialDisclosure>')
        rows = ptr.parse_index(xml, 2026) if hasattr(ptr, "parse_index") else ptr.index_rows(xml, 2026)
        self.assertEqual([r["doc_id"] for r in rows], ["20099999"])


class RussianRoot(unittest.TestCase):
    def test_bundled_root_matches_the_documented_fingerprint(self):
        import hashlib
        import ssl
        pem = open(net.RUSSIAN_ROOT_PEM, encoding="ascii").read()
        der = ssl.PEM_cert_to_DER_cert(pem)
        self.assertEqual(hashlib.sha256(der).hexdigest(), net.RUSSIAN_ROOT_SHA256)

    def test_root_is_added_for_tbank_only(self):
        net._CTX.clear()
        tb = net.ssl_context("invest-public-api.tbank.ru")
        other = net.ssl_context("api.telegram.org")
        self.assertIsNot(tb, other)
        names = [c.get("subject", ()) for c in tb.get_ca_certs()]
        self.assertTrue(any(("commonName", "Russian Trusted Root CA") in sum(s, ()) for s in names))
        names = [c.get("subject", ()) for c in other.get_ca_certs()]
        self.assertFalse(any(("commonName", "Russian Trusted Root CA") in sum(s, ()) for s in names))
        self.assertEqual(tb.verify_mode, ssl.CERT_REQUIRED)


class Network(unittest.TestCase):
    def test_allow_list(self):
        net.check_url("https://data.sec.gov/x", net.SEC_HOSTS)
        with self.assertRaises(net.NetError):
            net.check_url("http://data.sec.gov/x", net.SEC_HOSTS)
        with self.assertRaises(net.NetError):
            net.check_url("https://evil.example/x", net.SEC_HOSTS)
        with self.assertRaises(net.NetError):
            net.check_url("https://data.sec.gov.evil.example/x", net.SEC_HOSTS)
        with self.assertRaises(net.NetError):
            net.open_url("https://evil.example/", allowed=net.ALL_HOSTS)

    def test_proxy_is_off_unless_asked(self):
        old = dict(os.environ)
        try:
            os.environ["HTTPS_PROXY"] = "http://user:pw@corp-proxy:3128"
            os.environ.pop("TRADER_PROXY", None)
            self.assertEqual(net.proxy_handler().proxies, {})
            os.environ["TRADER_PROXY"] = "system"
            self.assertIn("https", net.proxy_handler().proxies)
            os.environ["TRADER_PROXY"] = "http://me:pw@proxy.local:8080"
            self.assertEqual(net.proxy_handler().proxies["https"], "http://me:pw@proxy.local:8080")
            # per host: Telegram through its own proxy, T-Bank stays direct
            os.environ.pop("TRADER_PROXY", None)
            os.environ["TELEGRAM_PROXY"] = "http://me:pw@tg.local:1080"
            self.assertEqual(net.proxy_handler("api.telegram.org").proxies["https"], "http://me:pw@tg.local:1080")
            self.assertEqual(net.proxy_handler("invest-public-api.tbank.ru").proxies, {})
            os.environ["TINVEST_PROXY"] = "direct"
            os.environ["TRADER_PROXY"] = "system"
            self.assertEqual(net.proxy_handler("invest-public-api.tbank.ru").proxies, {})
            self.assertIn("https", net.proxy_handler("www.sec.gov").proxies)
        finally:
            os.environ.clear()
            os.environ.update(old)

    def test_redirect_to_another_host_is_refused(self):
        h = net._SameListRedirects(net.SEC_HOSTS)
        req = urllib.request.Request("https://www.sec.gov/a")
        with self.assertRaises(net.NetError):
            h.redirect_request(req, None, 302, "Found", {}, "https://evil.example/b")
        new = h.redirect_request(req, None, 302, "Found", {}, "https://data.sec.gov/b")
        self.assertEqual(new.full_url, "https://data.sec.gov/b")


if __name__ == "__main__":
    unittest.main()
