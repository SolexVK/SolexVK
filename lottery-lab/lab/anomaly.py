"""Anomaly hunt for a single-field k-of-n lottery (Sprint 5).

The idea (a sharp one): instead of hunting *patterns*, hunt *anomalies* —
statistically improbable events — then ask of each whether it has a real CAUSE
(a biased machine, an RNG flaw, a rule change = a potential edge) or is just the
law of truly large numbers at work (pure chance = no edge).

The discipline that makes this honest: with tens of thousands of draws and many
statistics, apparent "anomalies" appear by chance (look-elsewhere effect). So
every candidate is judged against a proper fair-lottery NULL — analytic where
possible, Monte-Carlo for extreme-value statistics (max drought, max streak,
hottest pair) whose null is not closed-form.
"""
from __future__ import annotations
import csv
from math import comb
from collections import Counter
import numpy as np
from scipy import stats


def load_single_field(path: str, k: int):
    rows = list(csv.DictReader(open(path, encoding="utf-8")))
    main = np.array([sorted(int(r[f"n{i+1}"]) for i in range(k)) for r in rows])
    dates = [r["datetime"][:10] for r in rows]
    return main, dates


# ---- extreme-value statistics (need a Monte-Carlo null) ----
def _presence(M, n):
    P = np.zeros((len(M), n), dtype=bool)
    ri = np.repeat(np.arange(len(M)), M.shape[1])
    P[ri, M.ravel() - 1] = True
    return P


def max_drought_streak(M, n):
    P = _presence(M, n)
    md = ms = 0
    for num in range(n):
        col = P[:, num]
        idx = np.where(col)[0]
        if len(idx) > 1:
            md = max(md, int(np.diff(idx).max()))
        best = cur = 0
        for v in col:
            cur = cur + 1 if v else 0
            if cur > best:
                best = cur
        ms = max(ms, best)
    return md, ms


def max_pair_count(M, k):
    c = Counter()
    for row in M:
        for i in range(k):
            for j in range(i + 1, k):
                c[(row[i], row[j])] += 1
    return max(c.values())


def _fair(N, n, k, rng):
    keys = rng.random((N, n))
    return np.sort(np.argsort(keys, axis=1)[:, :k] + 1, axis=1)


def hunt(main, dates, n, k, reps=200, pair_reps=60, seed=20260809):
    N = len(main)
    findings = []

    def add(name, obs, null, higher_is_weird=True, note=""):
        pct = float((null < obs).mean()) if higher_is_weird else float((null > obs).mean())
        p95 = float(np.percentile(null, 95))
        weird = obs > p95 if higher_is_weird else obs < float(np.percentile(null, 5))
        findings.append({"name": name, "observed": float(obs),
                         "null_mean": float(null.mean()), "null_p95": p95,
                         "percentile": round(pct, 3), "anomaly": bool(weird), "note": note})

    # analytic: repeated combinations
    cnt = Counter(map(tuple, main))
    obs_pairs = sum(v * (v - 1) // 2 for v in cnt.values() if v > 1)
    exp_pairs = comb(N, 2) / comb(n, k)
    findings.append({"name": "repeated combinations (pairs)", "observed": obs_pairs,
                     "null_mean": round(exp_pairs, 2), "null_p95": None,
                     "percentile": None, "anomaly": obs_pairs > exp_pairs + 3 * exp_pairs ** 0.5,
                     "note": f"max multiplicity {max(cnt.values())}"})

    # analytic: consecutive / arithmetic combos
    def is_consec(d): return all(d[i + 1] - d[i] == 1 for i in range(len(d) - 1))
    nconsec = int(sum(is_consec(d) for d in main))
    exp_consec = N * (n - k + 1) / comb(n, k)
    findings.append({"name": "fully-consecutive combos", "observed": nconsec,
                     "null_mean": round(exp_consec, 3), "null_p95": None, "percentile": None,
                     "anomaly": nconsec > exp_consec + 4, "note": "e.g. 1-2-3-4-5-6-7"})

    # analytic: draw-to-draw carryover (independence check)
    carry = np.array([len(set(main[i].tolist()) & set(main[i - 1].tolist())) for i in range(1, N)])
    exp_carry = k * k / n
    findings.append({"name": "carryover from previous draw (mean)", "observed": round(float(carry.mean()), 4),
                     "null_mean": round(exp_carry, 4), "null_p95": None, "percentile": None,
                     "anomaly": abs(carry.mean() - exp_carry) > 0.05, "note": f"max {int(carry.max())} shared"})

    # analytic: most-extreme single number (Bonferroni over n)
    counts = np.bincount(main.ravel(), minlength=n + 1)[1:]
    p0 = k / n
    pmin = min(stats.binomtest(int(c), N, p0).pvalue for c in counts)
    findings.append({"name": "most-extreme number frequency", "observed": round(pmin, 4),
                     "null_mean": None, "null_p95": None, "percentile": None,
                     "anomaly": pmin * n < 0.05,
                     "note": f"Bonferroni p = {min(pmin*n,1):.3f} (x{n} numbers)"})

    # change-point: per-year chi-square, flag any year with Bonferroni-significant deviation
    years = np.array([int(d[:4]) for d in dates])
    yr_flags = []
    for y in sorted(set(years.tolist())):
        sel = years == y
        if sel.sum() < 200:
            continue
        c = np.bincount(main[sel].ravel(), minlength=n + 1)[1:]
        exp = sel.sum() * k / n
        chi2 = float(((c - exp) ** 2 / exp).sum())
        p = float(stats.chi2.sf(chi2, n - 1))
        if p * len(set(years.tolist())) < 0.05:
            yr_flags.append((int(y), round(p, 4)))
    findings.append({"name": "yearly regime shift (change-point)", "observed": len(yr_flags),
                     "null_mean": 0, "null_p95": None, "percentile": None,
                     "anomaly": len(yr_flags) > 0,
                     "note": "years failing Bonferroni: " + (str(yr_flags) if yr_flags else "none")})

    # Monte-Carlo extreme-value nulls
    rng = np.random.default_rng(seed)
    obs_md, obs_ms = max_drought_streak(main, n)
    obs_pair = max_pair_count(main, k)
    mds = np.empty(reps); mss = np.empty(reps); mps = np.empty(pair_reps)
    for r in range(reps):
        M = _fair(N, n, k, rng)
        mds[r], mss[r] = max_drought_streak(M, n)
        if r < pair_reps:
            mps[r] = max_pair_count(M, k)
    add("longest drought (max gap for a number)", obs_md, mds, True,
        "самая длинная серия НЕвыпадения одного числа")
    add("longest streak (consecutive appearances)", obs_ms, mss, True,
        "самое долгое присутствие одного числа подряд")
    add("hottest pair count", obs_pair, mps, True, "самая частая пара чисел")

    n_anom = sum(1 for f in findings if f["anomaly"])
    return {"game": f"{k} из {n}", "draws": N, "date_range": [dates[0], dates[-1]],
            "n_tests": len(findings), "n_anomalies": n_anom, "findings": findings,
            "_mc": {"drought_null": mds.tolist(), "drought_obs": obs_md,
                    "pair_null": mps.tolist(), "pair_obs": obs_pair,
                    "streak_null": mss.tolist(), "streak_obs": obs_ms}}
