#!/usr/bin/env python3
"""Download single-field k-of-n game archives into data/clean/<slug>.csv.

Usage: python3 scripts/download_games.py            # 6x45 and 7x49
Each row: draw, datetime, price, bets, summPayed, jackpot_kop, n1..nk,
and per-tier winners/amounts m{match}_w / m{match}_a (winners category i =
"match k+1-i"). Draws with a missing combination are skipped.
"""
from __future__ import annotations
import os, sys, json, csv
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
from lab.ingest import download_all

CLEAN = os.path.join(ROOT, "data", "clean")
GAMES = {"6x45": (45, 6), "7x49": (49, 7)}   # add more single-field games here


def extract(rows, k):
    out, skipped = [], 0
    for r in rows:
        cs = (r.get("combination") or {}).get("structured")
        if not cs or len(cs) < k:
            skipped += 1
            continue
        try:
            jackpot = int(json.loads(r["winningCategories"]).get("jackpot", 0) or 0)
        except Exception:
            jackpot = 0
        w = {c["category"]: c for c in r.get("winners", [])}
        rec = {"draw": r["number"], "datetime": r["date"],
               "price": r.get("ticketPrice") or 0, "bets": r.get("betsCount") or 0,
               "summPayed": r.get("summPayed") or 0, "jackpot_kop": jackpot}
        for i, num in enumerate(sorted(cs[:k])):
            rec[f"n{i+1}"] = num
        for cat in range(1, k):
            match = k + 1 - cat
            rec[f"m{match}_w"] = int((w.get(cat) or {}).get("participants", 0) or 0)
            rec[f"m{match}_a"] = int((w.get(cat) or {}).get("amount", 0) or 0)
        out.append(rec)
    out.sort(key=lambda x: x["draw"])
    return out, skipped


def main():
    os.makedirs(CLEAN, exist_ok=True)
    for slug, (n, k) in GAMES.items():
        print(f"downloading {slug} ...", flush=True)
        rows = download_all(slug)
        out, skipped = extract(rows, k)
        path = os.path.join(CLEAN, f"{slug}.csv")
        with open(path, "w", newline="", encoding="utf-8") as f:
            wr = csv.DictWriter(f, fieldnames=list(out[0].keys()))
            wr.writeheader(); wr.writerows(out)
        jmax = max(r["jackpot_kop"] for r in out) / 100 / 1e6
        print(f"  saved {slug}: {len(out)} draws (skipped {skipped}), max jackpot {jmax:.1f} mln rub")


if __name__ == "__main__":
    main()
