"""Payout & expected-value engine for 5x36plus (Sprint 2).

Prize structure (verified against realized winner counts in the archive):
  СУПЕР №1 : 5 of 5 AND the plus (1 of 4)   P = 1 / (C(36,5)*4)  = 1/1 507 968
  СУПЕР №2 : 5 of 5, plus NOT matched       P = 3 / (C(36,5)*4)  = 1/502 656
  4 из 5   : exactly 4 of 5 (no plus)        fixed 7500 / 7000 rub
  3 из 5   : exactly 3 of 5                   fixed 750 / 700 rub
  2 из 5   : exactly 2 of 5                   fixed 75 / 70 rub  (returns the stake)

Two honest edges live here:
  * EV / house edge and whether a rollover ever makes EV positive (H011).
  * Player-pick popularity: with fixed lower-tier prizes the "avoid popular
    numbers" edge only bites on the shared СУПЕР, but the *popularity itself*
    is measurable — the count of low-tier winners rises when the drawn numbers
    are ones players over-pick (H010).
"""
from __future__ import annotations
import csv
from math import comb
import numpy as np
from . import GAME

C36_5 = comb(36, 5)                        # 376 992
P_EXACT = {m: comb(5, m) * comb(31, 5 - m) / C36_5 for m in range(6)}
P_S1 = 1 / (C36_5 * 4)                      # 5 of 5 + plus
P_S2 = 3 / (C36_5 * 4)                      # 5 of 5, wrong plus


def load_payout(path: str) -> dict:
    """Load the payout CSV into column arrays keyed by draw number."""
    rows = list(csv.DictReader(open(path, encoding="utf-8")))
    def arr(k, cast=float):
        return np.array([cast(r[k] or 0) for r in rows])
    return {
        "draw": arr("draw", int),
        "bets": arr("bets", float),
        "price": arr("price", float),
        "jackpot_rub": arr("jackpot_kop", float) / 100.0,
        "s1": arr("s1_part", float), "s2": arr("s2_part", float),
        "w4": arr("w4of5", float), "w3": arr("w3of5", float), "w2": arr("w2of5", float),
        "a4": arr("a4of5", float), "a3": arr("a3of5", float), "a2": arr("a2of5", float),
        "summPayed": arr("summPayed", float),
    }


# --------------------------------------------------------------- EV / edge
def theoretical_ev(price: float, jackpot1: float, jackpot2: float) -> dict:
    """Exact EV of one board at the given super jackpots (no sharing)."""
    prize2, prize3, prize4 = price, price * 10, price * 100   # 75 / 750 / 7500
    ev_low = P_EXACT[2] * prize2 + P_EXACT[3] * prize3 + P_EXACT[4] * prize4
    ev_super = P_S1 * jackpot1 + P_S2 * jackpot2
    ev = ev_low + ev_super
    return {
        "price": price, "ev": ev, "rtp": ev / price,
        "ev_low_tiers": ev_low, "ev_super": ev_super,
        "contrib": {"2of5": P_EXACT[2] * prize2, "3of5": P_EXACT[3] * prize3,
                     "4of5": P_EXACT[4] * prize4,
                     "S1": P_S1 * jackpot1, "S2": P_S2 * jackpot2},
    }


def realized_rtp(pay: dict) -> dict:
    """Empirical return-to-player = prizes paid / stakes, pooled and per-tier.

    This is the authoritative house-edge figure: it uses the actual rubles paid
    (summPayed) and actual stakes, independent of any pricing assumption. Per-tier
    contributions come from the realized winner counts x prize amounts; the super
    contribution is whatever summPayed has beyond the three lower tiers.
    """
    m = (pay["bets"] > 0) & (pay["price"] > 0)
    stakes = (pay["bets"][m] * pay["price"][m]).sum()
    low2 = (pay["w2"][m] * pay["a2"][m]).sum()
    low3 = (pay["w3"][m] * pay["a3"][m]).sum()
    low4 = (pay["w4"][m] * pay["a4"][m]).sum()
    total = pay["summPayed"][m].sum()
    super_paid = max(total - low2 - low3 - low4, 0.0)
    price = float(np.median(pay["price"][m]))
    return {
        "pooled_rtp": float(total / stakes),
        "house_edge": float(1 - total / stakes),
        "rtp_by_tier": {
            "2of5": float(low2 / stakes), "3of5": float(low3 / stakes),
            "4of5": float(low4 / stakes), "super": float(super_paid / stakes)},
        # realized average lower-tier return per board (in rubles), the EV baseline
        "lower_return_per_board": float((low2 + low3 + low4) / (pay["bets"][m].sum())),
        "median_price": price,
    }


def positive_ev_threshold(lower_return_per_board: float, price: float, jackpot2: float) -> dict:
    """Super-1 jackpot needed to lift a board's EV to its price, using the
    EMPIRICAL lower-tier return (not an assumed schedule)."""
    needed = (price - lower_return_per_board - P_S2 * jackpot2) / P_S1
    return {"jackpot1_needed_for_ev0": needed}


# ------------------------------------------------- player-pick popularity
def popularity_delta(mask: np.ndarray, rate: np.ndarray) -> np.ndarray:
    """For each number j: mean winner-rate in draws where j was drawn minus
    where it was not. Under uniform player picks this is ~0 for every j."""
    cnt_in = mask.sum(axis=0)
    cnt_out = mask.shape[0] - cnt_in
    sum_in = rate @ mask
    total = rate.sum()
    mean_in = sum_in / cnt_in
    mean_out = (total - sum_in) / cnt_out
    return mean_in - mean_out


def popularity_test(mask: np.ndarray, w: np.ndarray, bets: np.ndarray,
                    p_tier: float, reps: int = 500, seed: int = 20260809) -> dict:
    """Test H010: do players pick numbers non-uniformly?

    Observed: delta_j from real winner counts at a tier.
    Null: winners simulated as Binomial(bets, p_tier) under UNIFORM picks, using
    the real drawn-number masks. Statistic T = sum_j delta_j^2. p = fraction of
    null T >= observed. Also recovers per-number popularity and its correlation
    with the number value (are low/"calendar" numbers over-picked?).
    """
    m = bets > 0
    mask, w, bets = mask[m], w[m], bets[m]
    rate = w / bets
    obs_delta = popularity_delta(mask, rate)
    obs_T = float(np.sum(obs_delta ** 2))

    rng = np.random.default_rng(seed)
    null_T = np.empty(reps)
    for r in range(reps):
        sim = rng.binomial(bets.astype(int), p_tier) / bets
        null_T[r] = np.sum(popularity_delta(mask, sim) ** 2)
    p_value = float((np.sum(null_T >= obs_T) + 1) / (reps + 1))

    nums = np.arange(1, GAME["main_n"] + 1)
    # Spearman corr of popularity with number value (rank-based, no scipy dep)
    spearman = float(np.corrcoef(_rank(obs_delta), _rank(nums.astype(float)))[0, 1])
    # calendar effect: numbers 1..31 vs 32..36
    cal = nums <= 31
    calendar_gap = float(obs_delta[cal].mean() - obs_delta[~cal].mean())
    order = np.argsort(obs_delta)[::-1]
    return {
        "tier_p": p_tier, "n_draws": int(m.sum()),
        "observed_T": obs_T, "null_T_mean": float(null_T.mean()),
        "p_value": p_value, "reps": reps,
        "delta_by_number": obs_delta.tolist(),
        "null_delta_sd": float(np.sqrt(np.mean([_v(rng, mask, bets, p_tier) for _ in range(30)]))),
        "spearman_delta_vs_value": spearman,
        "calendar_gap_1_31_vs_32_36": calendar_gap,
        "most_overpicked": [(int(nums[i]), round(float(obs_delta[i]), 6)) for i in order[:6]],
        "most_underpicked": [(int(nums[i]), round(float(obs_delta[i]), 6)) for i in order[-6:]],
    }


def _rank(x: np.ndarray) -> np.ndarray:
    o = np.argsort(np.argsort(x))
    return o.astype(float)


def _v(rng, mask, bets, p_tier):
    sim = rng.binomial(bets.astype(int), p_tier) / bets
    return np.var(popularity_delta(mask, sim))
