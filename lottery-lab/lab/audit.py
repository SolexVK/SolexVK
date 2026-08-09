"""Randomness-audit battery.

IMPORTANT: every test here is an AUDIT tool, not a prediction tool. A passing
test confirms the draw process behaves like a fair RNG; a failing test flags a
possible defect. Neither ever makes a number "more likely" next draw.
"""
from __future__ import annotations
import numpy as np
from scipy import stats
from . import GAME
from .montecarlo import main_counts, null_chi2_distribution


# ---------------------------------------------------------------- frequency
def chi2_uniform(counts: np.ndarray, n_draws: int, k_per_draw: int) -> dict:
    """Chi-square goodness-of-fit against a uniform pool."""
    cats = len(counts)
    exp = n_draws * k_per_draw / cats
    chi2 = float(np.sum((counts - exp) ** 2 / exp))
    df = cats - 1
    p = float(stats.chi2.sf(chi2, df))
    return {"chi2": chi2, "df": df, "p_value": p, "expected_per_cat": exp}


def per_number_fdr(main: np.ndarray) -> dict:
    """Two-sided exact binomial test for each of the 36 numbers, then
    Benjamini-Hochberg FDR correction across all 36 — the multiple-comparison
    guard that stops us from crowning a lucky number a 'hot' one."""
    n = len(main)
    p0 = GAME["main_k"] / GAME["main_n"]
    counts = main_counts(main)
    pvals = np.array([
        stats.binomtest(int(c), n, p0).pvalue for c in counts
    ])
    # Benjamini-Hochberg
    order = np.argsort(pvals)
    ranked = pvals[order]
    m = len(pvals)
    crit = np.arange(1, m + 1) / m * 0.05
    passed = ranked <= crit
    n_signif = int(np.max(np.where(passed)[0]) + 1) if passed.any() else 0
    signif_numbers = sorted((order[:n_signif] + 1).tolist()) if n_signif else []
    return {
        "min_raw_p": float(pvals.min()),
        "n_significant_after_fdr": n_signif,
        "significant_numbers": signif_numbers,
        "expected_false_positives_at_0.05": round(0.05 * m, 2),
    }


# ---------------------------------------------------------------- runs test
def runs_test(series: np.ndarray) -> dict:
    """Wald-Wolfowitz runs test around the median: detects clustering/trends
    in a sequence (here applied to the per-draw sum of main balls)."""
    med = np.median(series)
    signs = series > med
    signs = signs[series != med]  # drop ties
    n1 = int(np.sum(signs))
    n2 = int(np.sum(~signs))
    runs = 1 + int(np.sum(signs[1:] != signs[:-1]))
    mu = 2 * n1 * n2 / (n1 + n2) + 1
    var = (2 * n1 * n2 * (2 * n1 * n2 - n1 - n2)) / ((n1 + n2) ** 2 * (n1 + n2 - 1))
    z = (runs - mu) / np.sqrt(var)
    p = float(2 * stats.norm.sf(abs(z)))
    return {"runs": runs, "expected_runs": round(mu, 1), "z": round(float(z), 3), "p_value": p}


# --------------------------------------------------------------- autocorr
def autocorrelation(series: np.ndarray, max_lag: int = 20) -> dict:
    """Lag-1..max_lag autocorrelation with a JOINT Ljung-Box test.

    Counting individual lags outside the ±1.96/sqrt(n) band is a multiple-
    comparison trap: over `max_lag` lags ~5% will fall outside by chance. The
    Ljung-Box Q statistic tests all lags jointly with a single p-value and is
    what the verdict uses; per-lag bands are kept for the chart only.
    """
    n = len(series)
    x = series - series.mean()
    denom = np.sum(x ** 2)
    acf = [float(np.sum(x[l:] * x[:-l]) / denom) for l in range(1, max_lag + 1)]
    band = 1.96 / np.sqrt(n)
    outside = [i + 1 for i, a in enumerate(acf) if abs(a) > band]
    # Ljung-Box: Q = n(n+2) * sum_k acf_k^2 / (n-k) ~ chi2(max_lag)
    q = n * (n + 2) * sum(a ** 2 / (n - (k + 1)) for k, a in enumerate(acf))
    lb_p = float(stats.chi2.sf(q, max_lag))
    return {"acf": acf, "band_95": float(band), "lags_outside_band": outside,
            "expected_outside_by_chance": round(0.05 * max_lag, 1),
            "ljung_box_Q": round(float(q), 2), "ljung_box_p": lb_p, "max_lag": max_lag}


# ---------------------------------------------------------------- entropy
def entropy_ratio(counts: np.ndarray) -> dict:
    """Shannon entropy of the frequency distribution / maximum possible.
    1.0 = perfectly uniform; a deficit hints at exploitable structure."""
    p = counts / counts.sum()
    p = p[p > 0]
    h = -np.sum(p * np.log2(p))
    hmax = np.log2(len(counts))
    return {"entropy_bits": float(h), "max_bits": float(hmax), "ratio": float(h / hmax)}


# ---------------------------------------------------------------- gap test
def gap_test(main: np.ndarray) -> dict:
    """For every number, gaps (in draws) between consecutive appearances.
    Under fairness gaps are geometric with p = 5/36; we KS-test the pooled
    gaps against that geometric and compare mean gap to the expected 1/p."""
    p0 = GAME["main_k"] / GAME["main_n"]
    n = len(main)
    present = np.zeros((n, GAME["main_n"] + 1), dtype=bool)
    for j in range(GAME["main_k"]):
        present[np.arange(n), main[:, j]] = True
    all_gaps = []
    for num in range(1, GAME["main_n"] + 1):
        idx = np.where(present[:, num])[0]
        if len(idx) > 1:
            all_gaps.extend(np.diff(idx).tolist())
    all_gaps = np.array(all_gaps)
    # KS vs geometric(p0): CDF of geometric (gaps>=1)
    ks = stats.ks_1samp(all_gaps, lambda x: stats.geom.cdf(x, p0))
    return {
        "n_gaps": int(len(all_gaps)),
        "mean_gap": round(float(all_gaps.mean()), 3),
        "expected_mean_gap": round(1 / p0, 3),
        "ks_stat": round(float(ks.statistic), 4),
        "ks_p_value": float(ks.pvalue),
    }


# --------------------------------------------------------- monte-carlo check
def montecarlo_check(main: np.ndarray, null: np.ndarray) -> dict:
    """Where does the observed main-frequency chi-square sit inside the
    empirical null distribution (precomputed fair datasets)? This validates the
    analytic p-value with a simulation that assumes nothing."""
    n = len(main)
    exp = n * GAME["main_k"] / GAME["main_n"]
    obs = float(np.sum((main_counts(main) - exp) ** 2 / exp))
    pct = float(np.mean(null < obs))
    return {
        "observed_chi2": round(obs, 2),
        "null_mean_chi2": round(float(null.mean()), 2),
        "observed_percentile": round(pct, 4),
        "reps": int(len(null)),
    }


def run_full_audit(main: np.ndarray, plus: np.ndarray, null: np.ndarray) -> dict:
    """Run the whole battery and return a structured verdict."""
    n = len(main)
    sums = main.sum(axis=1)
    main_freq = chi2_uniform(main_counts(main), n, GAME["main_k"])
    plus_freq = chi2_uniform(np.bincount(plus, minlength=GAME["plus_n"] + 1)[1:],
                             n, GAME["plus_k"])
    res = {
        "n_draws": n,
        "main_frequency_chi2": main_freq,
        "plus_frequency_chi2": plus_freq,
        "per_number_fdr": per_number_fdr(main),
        "runs_test_on_sum": runs_test(sums),
        "autocorrelation_of_sum": autocorrelation(sums),
        "entropy_main": entropy_ratio(main_counts(main)),
        "gap_test_main": gap_test(main),
        "montecarlo_chi2": montecarlo_check(main, null),
    }
    # Overall verdict: does anything fail at alpha=0.05 after the guards?
    flags = []
    if main_freq["p_value"] < 0.05:
        flags.append("main frequency non-uniform")
    if plus_freq["p_value"] < 0.05:
        flags.append("plus frequency non-uniform")
    if res["per_number_fdr"]["n_significant_after_fdr"] > 0:
        flags.append("a number deviates after FDR")
    if res["runs_test_on_sum"]["p_value"] < 0.05:
        flags.append("sum series shows runs structure")
    if res["autocorrelation_of_sum"]["ljung_box_p"] < 0.05:
        flags.append("sum autocorrelation (Ljung-Box) significant")
    res["verdict"] = {
        "fair_consistent": len(flags) == 0,
        "flags": flags,
    }
    return res
