"""Walk-forward backtest harness for number-picking strategies (Sprint 3).

A *strategy* looks only at the history BEFORE draw t and outputs one 5-number
ticket; we then score it against the real draw t. Because a fair lottery's
draws are independent of history, every strategy must score the same as random
selection — the expected number of matches is 5*(5/36)=0.6944 per draw for ANY
ticket. This harness proves that empirically and gives you a slot to drop in
your OWN hypothesis (see `STRATEGIES`).
"""
from __future__ import annotations
import numpy as np
from . import GAME

N_POOL, K = GAME["main_n"], GAME["main_k"]

# Fixed prize schedule (current 75-rub era) for a rough per-strategy EV.
PRICE = 75
PRIZE = {0: 0, 1: 0, 2: 75, 3: 750, 4: 7500, 5: 2_180_000}  # 5=avg super value


# --------------------------------------------------------------- strategies
# Each strategy: (counts[36], last_seen[36], t, prev_draw, rng) -> 5 numbers.
# Add your own hypothesis here and it is tested on the same footing as the rest.
def s_random(counts, last, t, prev, rng):
    return (rng.choice(N_POOL, K, replace=False) + 1).tolist()

def s_hot(counts, last, t, prev, rng):
    return (np.argsort(counts, kind="stable")[-K:] + 1).tolist()

def s_cold(counts, last, t, prev, rng):
    return (np.argsort(counts, kind="stable")[:K] + 1).tolist()

def s_overdue(counts, last, t, prev, rng):
    gap = t - last                       # unseen numbers have the largest gap
    return (np.argsort(gap, kind="stable")[-K:] + 1).tolist()

def s_repeat_last(counts, last, t, prev, rng):
    return prev.tolist()                 # "the numbers are on a streak"

def s_delta(counts, last, t, prev, rng):
    while True:                          # the popular "delta system"
        d = rng.integers(1, 9, size=K)
        nums = np.cumsum(d)
        if nums[-1] <= N_POOL:
            return (nums + (rng.integers(0, N_POOL - nums[-1] + 1))).tolist()

def s_popular_calendar(counts, last, t, prev, rng):
    return [3, 7, 9, 11, 17]             # low/"lucky" numbers people pick

def s_unpopular(counts, last, t, prev, rng):
    return [30, 32, 34, 35, 36]          # least-picked (Sprint 2) -> payout only

STRATEGIES = {
    "random (baseline)": s_random,
    "hot (частые)": s_hot,
    "cold (редкие)": s_cold,
    "overdue (просроченные)": s_overdue,
    "repeat-last (повтор)": s_repeat_last,
    "delta-system": s_delta,
    "popular (календарные)": s_popular_calendar,
    "unpopular (непопулярные)": s_unpopular,
}


# --------------------------------------------------------------- engine
def run_backtest(main: np.ndarray, warmup: int = 2000, seed: int = 20260809) -> dict:
    """Walk forward through the draws; return {strategy: matches[] per draw}."""
    n = len(main)
    counts = np.zeros(N_POOL)
    last = np.full(N_POOL, -1)
    for t in range(warmup):
        idx = main[t] - 1
        counts[idx] += 1
        last[idx] = t
    rng = np.random.default_rng(seed)
    out = {name: np.empty(n - warmup, dtype=np.int8) for name in STRATEGIES}
    for i, t in enumerate(range(warmup, n)):
        drawn = set(main[t].tolist())
        prev = main[t - 1]
        for name, fn in STRATEGIES.items():
            ticket = fn(counts, last, t, prev, rng)
            out[name][i] = len(drawn.intersection(ticket))
        idx = main[t] - 1
        counts[idx] += 1
        last[idx] = t
    return out


def null_mean_band() -> dict:
    """Analytic null for the mean number of matches of ANY ticket per draw.

    Matches ~ Hypergeometric(N=36, K=5 drawn, n=5 ticket).
    """
    mean = K * K / N_POOL
    var = K * (K / N_POOL) * (1 - K / N_POOL) * (N_POOL - K) / (N_POOL - 1)
    return {"per_draw_mean": mean, "per_draw_var": var}


def score(matches: np.ndarray) -> dict:
    """Summarise a strategy: mean matches, per-tier hit rates, rough EV, and a
    z-test of mean matches against the random null."""
    n = len(matches)
    nb = null_mean_band()
    mean = float(matches.mean())
    sd_mean = float(np.sqrt(nb["per_draw_var"] / n))
    z = (mean - nb["per_draw_mean"]) / sd_mean
    # two-sided p from normal
    from math import erfc, sqrt
    p = float(erfc(abs(z) / sqrt(2)))
    ev = float(np.mean([PRIZE[m] for m in matches])) - PRICE
    tiers = {f"ge{m}": float((matches >= m).mean()) for m in (2, 3, 4)}
    return {"n": n, "mean_matches": mean, "z_vs_random": round(z, 3),
            "p_value": p, "ev_per_ticket": round(ev, 2), "tier_hit_rates": tiers}
