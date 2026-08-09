"""Economics of playing a SYSTEM of combinations on one draw (Sprint 3.5).

Question: can covering many combinations (wheeling, up to buying EVERY ticket
a la Stefan Mandel) beat the lottery on a single draw?

Two facts settle it:
  * EV is linear in stake. Spreading N rubles over any set of combinations
    returns the same fraction (the RTP) as one ticket. Systems reshape RISK
    (coverage guarantees, lower variance) but never the MEAN.
  * The only structural exploit is Mandel's: buy ALL combinations when the
    jackpot exceeds the cost of doing so. This module checks that condition on
    every archived draw.

Buying all C(36,5)*4 = 1,507,968 tickets guarantees СУПЕР №1 and a fixed,
combinatorial haul of every lower tier. We value the lower tiers at their
NOMINAL fixed prize (not each draw's realized amount): flooding a draw with
1.5M tickets would itself collapse any low-volume pari-mutuel top-up, so using
the inflated realized amounts would be self-contradictory.
"""
from __future__ import annotations
from math import comb
import numpy as np

C36_5 = comb(36, 5)                 # 376 992
PLUS = 4
TOTAL_TICKETS = C36_5 * PLUS        # 1 507 968 to guarantee СУПЕР №1
S2_PRIZE = 1_000_000.0

# how many of MY tickets win each tier if I own every combination:
N_S2 = 3                                    # 5 main, 3 wrong plus values
N_4 = comb(5, 4) * comb(31, 1) * PLUS       # exactly 4 of 5, any plus  = 620
N_3 = comb(5, 3) * comb(31, 2) * PLUS       #                           = 18 600
N_2 = comb(5, 2) * comb(31, 3) * PLUS       #                           = 179 800


def full_cover(pay: dict) -> dict:
    """Per-draw economics of buying every combination. Prices scale the nominal
    prize ladder (2of5 = 1x price, 3of5 = 10x, 4of5 = 100x)."""
    m = pay["price"] > 0
    price = pay["price"][m]
    jackpot = pay["jackpot_rub"][m]
    cost = TOTAL_TICKETS * price
    fixed = N_S2 * S2_PRIZE + N_4 * (price * 100) + N_3 * (price * 10) + N_2 * price
    ret = jackpot + fixed
    ratio = ret / cost
    best = int(np.argmax(ratio))
    price_med = float(np.median(price))
    fixed_med = N_S2 * S2_PRIZE + N_4 * price_med * 100 + N_3 * price_med * 10 + N_2 * price_med
    breakeven_jackpot = TOTAL_TICKETS * price_med - fixed_med
    return {
        "tickets_to_cover": TOTAL_TICKETS,
        "cost_at_75": TOTAL_TICKETS * 75,
        "mean_return_over_cost": float(ratio.mean()),
        "best_return_over_cost": float(ratio.max()),
        "best_draw": int(pay["draw"][m][best]),
        "best_jackpot_rub": float(jackpot[best]),
        "best_pl_rub": float(ret[best] - cost[best]),
        "profitable_draws": int((ratio > 1).sum()),
        "n_draws": int(m.sum()),
        "breakeven_jackpot_rub": float(breakeven_jackpot),
        "max_jackpot_rub": float(jackpot.max()),
        "_ratio": ratio, "_jackpot": jackpot,     # for plotting
    }
