"""Loading and validating the cleaned draw dataset."""
from __future__ import annotations
import csv
from dataclasses import dataclass
import numpy as np
from . import GAME


@dataclass
class Draws:
    """Immutable, validated view of the draw history as numpy arrays."""
    numbers: np.ndarray      # draw id, shape (N,)
    main: np.ndarray         # main balls, shape (N, 5), each in 1..36, row-sorted
    plus: np.ndarray         # plus ball, shape (N,), each in 1..4
    dates: list[str]

    def __len__(self) -> int:
        return len(self.numbers)


def load_draws(csv_path: str) -> Draws:
    """Load the clean CSV and validate every row against the game rules.

    Raises ValueError on any integrity violation so bad data never silently
    reaches the analysis engine.
    """
    nums, main, plus, dates = [], [], [], []
    with open(csv_path, newline="", encoding="utf-8") as f:
        for i, row in enumerate(csv.DictReader(f)):
            m = sorted(int(row[k]) for k in ("m1", "m2", "m3", "m4", "m5"))
            p = int(row["plus"])
            if len(set(m)) != GAME["main_k"]:
                raise ValueError(f"row {i}: main field has duplicates: {m}")
            if not all(1 <= x <= GAME["main_n"] for x in m):
                raise ValueError(f"row {i}: main out of range: {m}")
            if not 1 <= p <= GAME["plus_n"]:
                raise ValueError(f"row {i}: plus out of range: {p}")
            nums.append(int(row["draw"]))
            main.append(m)
            plus.append(p)
            dates.append(row["datetime"])
    order = np.argsort(nums)
    nums = np.asarray(nums)[order]
    return Draws(
        numbers=nums,
        main=np.asarray(main)[order],
        plus=np.asarray(plus)[order],
        dates=[dates[i] for i in order],
    )


def integrity_report(d: Draws) -> dict:
    """Cheap structural checks reported alongside every run."""
    gaps = np.diff(d.numbers)
    missing = int(np.sum(gaps - 1))  # skipped draw ids
    return {
        "draws": len(d),
        "draw_range": [int(d.numbers[0]), int(d.numbers[-1])],
        "date_range": [d.dates[0], d.dates[-1]],
        "missing_draw_ids": missing,
        "duplicate_draw_ids": int(len(d.numbers) - len(np.unique(d.numbers))),
    }
