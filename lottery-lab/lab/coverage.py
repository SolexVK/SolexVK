"""Full-coverage ("buy every combination", Mandel-style) economics for any
single-field k-of-n lottery (Sprint 4).

Answers: on a given draw, would buying all C(n,k) combinations return more than
it costs? The only way a lottery is beatable, and it needs the accumulated
jackpot to exceed the house-edge cost of covering everything.

Honest model — the lower tiers are PARI-MUTUEL (a prize pool split among
winners), verified by a negative correlation between per-winner amount and
winner count. So flooding a draw with C(n,k) tickets does NOT pay you the
current per-winner amounts (those would collapse as you become nearly every
winner). Instead you capture each tier's POOL, which is a fixed fraction of
sales. Net:

    return  ≈  lower_pool_fraction * your_stake   +   jackpot (rolled over)
    cost    =  C(n,k) * price
    profit  =  jackpot − (1 − lower_pool_fraction) * cost

The jackpot is external money accumulated from past unclaimed draws, which is
why a big enough rollover can cross the threshold.
"""
from __future__ import annotations
import csv
from math import comb
import numpy as np


def load_game(path: str, k: int) -> dict:
    rows = list(csv.DictReader(open(path, encoding="utf-8")))
    def a(col, cast=float):
        return np.array([cast(r.get(col) or 0) for r in rows])
    d = {"draw": a("draw", int), "price": a("price"), "bets": a("bets"),
         "jackpot_rub": a("jackpot_kop") / 100.0, "summPayed": a("summPayed")}
    for mm in range(2, k + 1):
        if f"m{mm}_w" in rows[0]:
            d[f"m{mm}_w"] = a(f"m{mm}_w")
            d[f"m{mm}_a"] = a(f"m{mm}_a")
    return d


def coverage_economics(g: dict, n: int, k: int) -> dict:
    price, bets, jackpot = g["price"], g["bets"], g["jackpot_rub"]
    m = (price > 0) & (bets > 0)
    sales = bets * price
    total = comb(n, k)
    price_med = float(np.median(price[m]))
    cost = total * price_med

    # lower-tier pool fraction of sales (tiers below the jackpot: match 2..k-1)
    lower_paid = np.zeros(len(price))
    for mm in range(2, k):
        if f"m{mm}_w" in g:
            lower_paid += g[f"m{mm}_w"] * g[f"m{mm}_a"]
    lf = float(np.median((lower_paid[m] / sales[m])))

    flood_ret = lf * cost + jackpot
    ratio = np.where(m, flood_ret / cost, 0.0)
    prof = ratio > 1
    best = int(np.argmax(ratio))
    rtp = float(g["summPayed"][m].sum() / sales[m].sum())
    breakeven = (1 - lf) * cost
    # expected other jackpot winners at the profitable draws (sharing risk)
    coexp = float(np.max(bets[prof] / total)) if prof.any() else 0.0
    return {
        "n": n, "k": k, "draws": int(m.sum()),
        "combinations": total, "price": price_med, "cover_cost_rub": cost,
        "realized_rtp": rtp, "house_edge": 1 - rtp,
        "lower_pool_fraction": lf,
        "breakeven_jackpot_rub": breakeven,
        "max_jackpot_rub": float(jackpot[m].max()),
        "mean_ratio": float(ratio[m].mean()),
        "best_ratio": float(ratio[best]), "best_draw": int(g["draw"][best]),
        "best_jackpot_rub": float(jackpot[best]),
        "best_gross_profit_rub": float(flood_ret[best] - cost),
        "profitable_draws": int(prof.sum()),
        "max_expected_cowinners": coexp,
        "_ratio": ratio[m], "_jackpot": jackpot[m],
    }
