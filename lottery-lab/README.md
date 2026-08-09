# 🎲 Lottery-Lab

A rigorous research toolkit for analysing lottery draws — built around the
Russian **Stoloto «5 из 36 плюс» (5x36plus)** as the first target.

## Scientific stance (read this first)

In a **fair** lottery, draws are independent: the machine has no memory, so the
history of past draws carries **zero** information about the next one. "Hot",
"cold", "due", and "pattern-continuation" systems are the *gambler's fallacy* —
a proven reasoning error, not a strategy.

This project therefore does **not** try to "predict" winning numbers. It does
two things that are actually defensible:

1. **Audit fairness** — statistically test whether the draw process behaves like
   a fair RNG. A failing test would flag a *defective machine* (which has
   happened historically); a passing test confirms there is no edge to find.
2. **Study the payout side** — the *one* real, legal edge: choosing
   rarely-picked combinations doesn't change your odds of winning, but it
   reduces how often you'd split a jackpot, raising expected *return*.

Every result is defended against self-deception: a fair-RNG **null model**
(Monte-Carlo), **multiple-comparison correction** (Benjamini–Hochberg FDR),
and a pre-registered **experiment registry**.

## Layout

```
lottery-lab/
├── lab/                     # library
│   ├── ingest.py            # reverse-engineered Stoloto mobile-API client
│   ├── dataio.py            # load + validate the clean dataset
│   ├── montecarlo.py        # fair-draw generator = null baseline
│   ├── audit.py             # randomness-audit battery (χ², runs, Ljung-Box, gap, entropy, MC)
│   └── descriptive.py       # frequencies, sums, odd/even, hot/cold (past only)
├── scripts/
│   ├── download.py          # rebuild data/ from the live archive
│   └── run_audit.py         # Sprint 1: run the audit, emit report + figures
├── data/
│   ├── clean/5x36plus.csv          # 25,043 draws (committed, authoritative)
│   ├── clean/5x36plus_payout.csv   # per-draw prize-category data (for EV work)
│   └── SNAPSHOT.json               # provenance + sha256
├── hypotheses/registry.yaml # pre-registered hypotheses + results
└── runs/                    # reports + figures per sprint
```

## Data

- **Source:** Stoloto mobile API (`/p/api/mobile/api/v35/service/draws/archive`),
  reverse-engineered from the site's Next.js bundles. See `lab/ingest.py`.
- **Coverage:** 25,043 draws, №139205–164254 (2025-06-17 → 2026-08-09, ~14 months).
- **Structure:** 5 distinct numbers of 1–36 + one "плюс" of 1–4 (independent RNG).
- **Limit:** the endpoint caps depth at ~25k recent draws and ignores date
  filters. To extend history, add a secondary source (see `ingest.py` notes).
- **Note:** the CSVs and figures are git-ignored (large, regenerable). Run
  `python3 scripts/download.py` to (re)build `data/clean/*.csv`, then
  `python3 scripts/run_audit.py` to regenerate `runs/`. `data/SNAPSHOT.json`
  records the authoritative sha256 of the dataset the committed report used.

## Quick start

```bash
pip install -r requirements.txt
python3 scripts/run_audit.py          # -> runs/sprint1_audit_report.md + figures
# python3 scripts/download.py         # refresh the dataset from the live archive
```

## Sprint 1 result

The 5x36plus draw process is **statistically consistent with a fair lottery**:
uniform frequencies (main χ² p=0.99, plus p=0.66), no number significant after
FDR, no serial dependence (Ljung–Box p=0.22), near-maximal entropy (0.99998).
→ There is **no predictive edge**. Next sprints focus on the **payout-EV** side.

See `runs/sprint1_audit_report.md` for the full table and caveats.

## Sprint 2 result — payout & EV

Run `python3 scripts/run_payout.py`. Findings on the real winner/payout data:

- **House edge ≈ 48%** (realized RTP 51.8%, from actual prizes paid ÷ stakes).
- **No positive-EV draw exists** (`H011`): EV would turn positive only above a
  ~66M ₽ СУПЕР-1 jackpot; the observed max is 18.8M ₽.
- **Players pick numbers non-uniformly** (`H010`, p=0.002): smaller / "calendar"
  numbers are over-picked (Spearman −0.50). But 5x36plus lower tiers pay a
  *fixed* per-draw amount, so this edge only bites on the shared СУПЕР jackpot —
  whose 1-in-1,507,968 odds make the practical EV uplift negligible. Real, measured,
  honestly un-exploitable.

Prize structure verified against reality: СУПЕР was won S1=18 / S2=58 times vs
19.3 / 58.0 expected. See `runs/sprint2_payout_report.md`.

## Sprint 3 result — hypothesis harness (walk-forward)

Run `python3 scripts/run_backtest.py`. Every strategy sees only the past at each
of 23,043 draws, picks a ticket, and is scored against the real result.

- **No strategy beats random** (`H020`): hot, cold, overdue, repeat-last, delta,
  popular, unpopular all score ~0.694 matches/draw — the random expectation.
  0 of 7 survive Benjamini–Hochberg FDR.
- **Test your own idea:** add a function to `lab/backtest.py` → `STRATEGIES`
  (`def s_x(counts, last, t, prev, rng): return [...5 numbers]`) and re-run — it
  faces the same walk-forward + null + FDR gauntlet. Pre-register it as `H021`.

See `runs/sprint3_backtest_report.md`.

## Sprint 4 result — full coverage on bigger jackpots (`H040`)

`python3 scripts/run_coverage.py` runs the honest pari-mutuel "buy every
combination" (Mandel) model across games. Full archives added for **6x45**
(18,357 draws, max jackpot 304M ₽) and **7x49** (23,733 draws, max 221M ₽).

| Game | C(n,k) | Cover cost | Break-even jackpot | Max jackpot | Mandel reached? |
|---|---|---|---|---|---|
| 5 из 36 плюс | 1.5M | 113M ₽ | 78M | 19M | No (0 draws) |
| **6 из 45** | 8.1M | 407M ₽ | 253M | **304M** | **Yes — 116 draws** |
| 7 из 49 | 85.9M | 4.3B ₽ | 2.8B | 221M | No (0 draws) |

Coverage cost grows **combinatorially** while jackpots grow ~linearly, so only
the mid-size **6x45** ever crossed the threshold (best case +51M ₽, ratio 1.13).
Still not exploitable: buying 8.1M tickets is logistically impossible, tax and
thin margins erase it. See `runs/sprint4_coverage_report.md`.

## Roadmap

- **Ongoing** — more games (4x20, topspin), deeper history via secondary
  sources, agent-orchestrated adversarial verification, and user-proposed
  strategies (`H021`+) run through the Sprint 3 harness.

> Research only. This toolkit does not place bets and provides no way to "beat"
> a fair lottery — because, mathematically, none exists.
