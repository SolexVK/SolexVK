"""Monte-Carlo generator of *fair* 5x36plus draws — our null baseline.

Every "pattern" we ever find in the real data must be compared against what a
provably-fair generator produces. If the real data is indistinguishable from
this, there is no predictive signal — by construction.
"""
from __future__ import annotations
import numpy as np
from . import GAME


def fair_draws(n: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Generate `n` fair draws. Returns (main[n,5] row-sorted, plus[n]).

    Vectorised: draw a random key per (draw, number), argsort each row and take
    the first k indices — this samples k distinct numbers without replacement
    for all n draws at once.
    """
    rng = np.random.default_rng(seed)
    keys = rng.random((n, GAME["main_n"]))
    idx = np.argsort(keys, axis=1)[:, : GAME["main_k"]]     # k distinct 0..35
    main = np.sort(idx + 1, axis=1).astype(np.int16)
    plus = rng.integers(1, GAME["plus_n"] + 1, size=n).astype(np.int16)
    return main, plus


def main_counts(main: np.ndarray) -> np.ndarray:
    """Count appearances of each number 1..36 across all draws -> shape (36,)."""
    return np.bincount(main.ravel(), minlength=GAME["main_n"] + 1)[1:]


def null_chi2_distribution(n: int, reps: int, base_seed: int = 20260809) -> np.ndarray:
    """Chi-square statistic of main-number frequencies under the fair null,
    repeated `reps` times, each on a fresh fair dataset of size `n`."""
    exp = n * GAME["main_k"] / GAME["main_n"]
    out = np.empty(reps)
    for r in range(reps):
        main, _ = fair_draws(n, seed=base_seed + r)
        out[r] = np.sum((main_counts(main) - exp) ** 2 / exp)
    return out
