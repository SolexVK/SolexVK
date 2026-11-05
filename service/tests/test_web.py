import http.client
import json
import os
import shutil
import tempfile
import unittest

import _path  # noqa: F401
from service.pack import Pack
from service.state import build_state, record_history, positions_with_pnl
from service.web import Panel

ROOT = _path.ROOT


class PanelTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dir, "trader", "state"))
        self.pack = Pack(self.dir, os.path.join(ROOT, "trader-skill"))
        self.pack.write("trader/config.json", {"broker": "tinvest", "paper": True, "currency": "RUB", "budget": 100000,
                                               "cash_buffer_pct": 10, "max_position_pct": 25, "max_order_usd": 30000})
        self.pack.write("trader/portfolio.json", {"cash": 14000.0, "positions": [
            {"ticker": "SBER", "shares": 85, "lots": [{"id": "SBER-1", "date": "2026-11-04", "shares": 85, "cost": 24699.3}]},
            {"ticker": "LKOH", "shares": 4, "lots": [{"id": "LKOH-1", "date": "2026-11-04", "shares": 4, "cost": 23790.0}]}]})
        self.pack.write("trader/prices.json", {"as_of": "2026-11-05T07:00:00Z", "prices": {"SBER": 300.0, "LKOH": 5900.0}})
        self.pack.write("trader/targets.json", {"source": "sirius", "weights": {"SBER": 50, "LKOH": 30, "GAZP": 20}})
        self.pack.write("trader/state/broker.json", {"orders": [{"at": "2026-11-04T22:55:57", "date": "2026-11-04", "index": 1,
                                                                 "status": "placed", "plain": "BUY 4 shares of LKOH", "broker_order_id": "c912095d"}]})
        self.panel = Panel(self.pack, None, {"web": {"host": "127.0.0.1", "port": 0, "secret": "s3cr3t-s3cr3t-s3cr3t"}})
        self.panel.start()

    def tearDown(self):
        self.panel.stop()
        shutil.rmtree(self.dir)

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.panel.port, timeout=5)
        c.request("GET", path)
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, r.getheader("Content-Type", ""), body

    def test_pnl_and_shares(self):
        s = positions_with_pnl(self.pack)
        sber = s["positions"][0]
        self.assertEqual(sber["ticker"], "SBER")
        self.assertAlmostEqual(sber["pnl"], 85 * 300 - 24699.3, places=2)
        self.assertAlmostEqual(s["total"], 14000 + 25500 + 23600, places=2)
        self.assertAlmostEqual(sum(r["share_pct"] for r in s["positions"]) + 100 * 14000 / s["total"], 100, places=1)

    def test_state_and_history(self):
        record_history(self.pack, label="open")
        record_history(self.pack, label="tick")
        s = build_state(self.pack, None, {})
        self.assertEqual(s["env"], "sandbox")
        self.assertEqual(len(s["history"]), 2)
        self.assertEqual(s["history"][-1]["label"], "tick")
        drift = {r["ticker"]: r for r in s["targets"]["rows"]}
        self.assertEqual(drift["GAZP"]["actual"], 0.0)
        self.assertAlmostEqual(drift["SBER"]["drift"], drift["SBER"]["actual"] - 50, places=2)
        self.assertEqual(s["decisions"][0]["status"], "placed")
        self.assertEqual(s["tickets"], [])  # no orders file: not an error for the panel

    def test_http_secret_gate(self):
        status, ctype, body = self.get("/d/s3cr3t-s3cr3t-s3cr3t")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ctype)
        self.assertIn("Торговая панель".encode("utf-8"), body)
        status, ctype, body = self.get("/d/s3cr3t-s3cr3t-s3cr3t/state.json")
        self.assertEqual(status, 200)
        doc = json.loads(body)
        self.assertEqual(doc["portfolio"]["positions"][0]["ticker"], "SBER")
        for bad in ("/", "/d/", "/d/wrong", "/d/s3cr3t-s3cr3t-s3cr3t/other", "/state.json"):
            status, ctype, body = self.get(bad)
            self.assertEqual(status, 404, bad)
            self.assertEqual(body, b"")

    def test_panel_off_with_a_short_secret(self):
        p = Panel(self.pack, None, {"web": {"host": "127.0.0.1", "port": 0, "secret": "short"}})
        self.assertFalse(p.enabled())
        p.stop()
        self.assertTrue(self.panel.url().endswith("/d/s3cr3t-s3cr3t-s3cr3t"))
        self.assertNotIn("s3cr3t-s3cr3t", self.panel.masked_url())
        self.assertFalse(self.panel.https())
        p2 = Panel(self.pack, None, {"web": {"host": "127.0.0.1", "port": 0, "secret": "s3cr3t-s3cr3t-s3cr3t",
                                            "public_url": "https://trade.example.ru/"}})
        self.assertTrue(p2.https())
        self.assertEqual(p2.url(), "https://trade.example.ru/d/s3cr3t-s3cr3t-s3cr3t")
        p2.stop()


if __name__ == "__main__":
    unittest.main()
