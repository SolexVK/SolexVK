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

## Roadmap

- **Sprint 2** — payout-EV engine: player-pick popularity, jackpot-share model,
  positive-EV detection (`H010`, `H011`).
- **Sprint 3** — hypothesis harness with walk-forward validation for any
  user-proposed "pattern", scored against the Monte-Carlo null.
- **Ongoing** — multi-game support (6x45, 4x20), deeper history via secondary
  sources, agent-orchestrated adversarial verification of every finding.

> Research only. This toolkit does not place bets and provides no way to "beat"
> a fair lottery — because, mathematically, none exists.
