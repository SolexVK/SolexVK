"""Descriptive statistics — the honest 'what the past looked like' layer.

None of this predicts the future; it characterises the sample and feeds the
fairness audit and (later) the payout model.
"""
from __future__ import annotations
import numpy as np
from . import GAME
from .montecarlo import main_counts


def summary(main: np.ndarray, plus: np.ndarray) -> dict:
    counts = main_counts(main)
    sums = main.sum(axis=1)
    odd = np.sum(main % 2 == 1, axis=1)          # odd count per draw (0..5)
    low = np.sum(main <= GAME["main_n"] // 2, axis=1)  # low-half count per draw
    return {
        "hottest": _top(counts, 5, most=True),
        "coldest": _top(counts, 5, most=False),
        "sum": {"min": int(sums.min()), "max": int(sums.max()),
                 "mean": round(float(sums.mean()), 2), "std": round(float(sums.std()), 2)},
        "odd_count_distribution": np.bincount(odd, minlength=6).tolist(),
        "low_count_distribution": np.bincount(low, minlength=6).tolist(),
        "plus_distribution": np.bincount(plus, minlength=GAME["plus_n"] + 1)[1:].tolist(),
    }


def _top(counts: np.ndarray, k: int, most: bool) -> list:
    order = np.argsort(counts)
    order = order[::-1] if most else order
    return [(int(i + 1), int(counts[i])) for i in order[:k]]
