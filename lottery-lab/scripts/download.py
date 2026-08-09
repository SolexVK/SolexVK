#!/usr/bin/env python3
"""Download the reachable 5x36plus archive and rebuild the clean CSVs.

Usage: python3 scripts/download.py
Writes: data/raw/5x36plus_raw.jsonl (git-ignored), data/clean/5x36plus.csv,
        data/clean/5x36plus_payout.csv, data/SNAPSHOT.json
"""
from __future__ import annotations
import os, sys, json, csv, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
from lab.ingest import download_all

RAW = os.path.join(ROOT, "data", "raw", "5x36plus_raw.jsonl")
CLEAN = os.path.join(ROOT, "data", "clean", "5x36plus.csv")
PAYOUT = os.path.join(ROOT, "data", "clean", "5x36plus_payout.csv")
SNAP = os.path.join(ROOT, "data", "SNAPSHOT.json")


def main():
    print("Downloading 5x36plus archive (polite, ~500 pages)...")
    rows = download_all("5x36plus")
    os.makedirs(os.path.dirname(RAW), exist_ok=True)
    with open(RAW, "w", encoding="utf-8") as f:
        for x in rows:
            f.write(json.dumps(x, ensure_ascii=False) + "\n")

    clean, payout = [], []
    for r in rows:
        c = r["combination"]["structured"]
        m = sorted(c[:5]); p = c[5]
        try:
            wc = json.loads(r["winningCategories"])
        except Exception:
            wc = {}
        clean.append({"draw": r["number"], "datetime": r["date"],
                      "m1": m[0], "m2": m[1], "m3": m[2], "m4": m[3], "m5": m[4], "plus": p,
                      "jackpot": wc.get("jackpot"), "tickets": wc.get("columns"),
                      "players": wc.get("players"), "ticketPrice": r.get("ticketPrice"),
                      "superPrizeWon": r.get("superPrizeWon")})
        # Realized winners come from the top-level `winners` array (participants +
        # per-winner amount), NOT from winningCategories (whose counts are 0 here).
        # category map: 1=СУПЕР№1, 2=СУПЕР№2, 3=4of5, 4=3of5, 5=2of5.
        w = {cat["category"]: cat for cat in r.get("winners", [])}
        def part(cat): return int((w.get(cat) or {}).get("participants", 0) or 0)
        def amt(cat): return int((w.get(cat) or {}).get("amount", 0) or 0)
        payout.append({
            "draw": r["number"], "datetime": r["date"],
            "bets": r.get("betsCount") or 0, "ticketCount": r.get("ticketCount") or 0,
            "price": r.get("ticketPrice") or 0,
            "jackpot_kop": int(wc.get("jackpot", 0) or 0),
            "superPrizeWon": r.get("superPrizeWon"),
            "s1_part": part(1), "s2_part": part(2),
            "w4of5": part(3), "a4of5": amt(3),
            "w3of5": part(4), "a3of5": amt(4),
            "w2of5": part(5), "a2of5": amt(5),
            "summPayed": r.get("summPayed") or 0,
        })

    _write_csv(CLEAN, clean)
    _write_csv(PAYOUT, payout)
    h = hashlib.sha256(open(CLEAN, "rb").read()).hexdigest()
    json.dump({"game": "5x36plus", "draws": len(rows),
               "draw_range": [rows[0]["number"], rows[-1]["number"]],
               "date_range": [rows[0]["date"], rows[-1]["date"]],
               "clean_csv_sha256": h}, open(SNAP, "w"), indent=2, ensure_ascii=False)
    print(f"Saved {len(rows)} draws. clean sha256 {h[:16]}...")


def _write_csv(path, rows):
    keys = []
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader(); w.writerows(rows)


if __name__ == "__main__":
    main()
