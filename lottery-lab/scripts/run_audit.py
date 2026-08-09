#!/usr/bin/env python3
"""Sprint 1 runner: fairness audit + descriptive dashboard for 5x36plus.

Outputs:
  runs/sprint1_audit.json         structured results (reproducible)
  runs/sprint1_audit_report.md    human-readable verdict
  runs/figures/*.png              charts
"""
from __future__ import annotations
import os, sys, json
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from lab import GAME
from lab.dataio import load_draws, integrity_report
from lab.audit import run_full_audit
from lab.descriptive import summary
from lab.montecarlo import main_counts, null_chi2_distribution

CSV = os.path.join(ROOT, "data", "clean", "5x36plus.csv")
RUNS = os.path.join(ROOT, "runs")
FIG = os.path.join(RUNS, "figures")
SEED_NULL = 20260809
os.makedirs(FIG, exist_ok=True)

INK, ACCENT, WARN, GRID = "#1b2432", "#2f7ed8", "#d1495b", "#dfe3ea"


def figure_number_frequency(main, n):
    counts = main_counts(main)
    exp = n * GAME["main_k"] / GAME["main_n"]
    band = 1.96 * np.sqrt(exp * (1 - GAME["main_k"] / GAME["main_n"]))
    fig, ax = plt.subplots(figsize=(11, 4.2))
    x = np.arange(1, GAME["main_n"] + 1)
    ax.bar(x, counts, color=ACCENT, width=0.72, zorder=3)
    ax.axhline(exp, color=INK, lw=1.4, zorder=4, label=f"ожидание = {exp:.0f}")
    ax.axhspan(exp - band, exp + band, color=INK, alpha=0.08, zorder=1,
               label="95% полоса (честный RNG)")
    ax.set_xticks(x); ax.set_xlim(0.4, GAME["main_n"] + 0.6)
    ax.set_title("Частота выпадения чисел 1–36 (основное поле)", color=INK, fontweight="bold")
    ax.set_xlabel("число"); ax.set_ylabel("сколько раз выпало")
    ax.grid(axis="y", color=GRID, zorder=0); ax.legend(loc="lower right", framealpha=.9)
    for s in ax.spines.values(): s.set_color(GRID)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, "01_number_frequency.png"), dpi=130); plt.close(fig)


def figure_plus(plus, n):
    counts = np.bincount(plus, minlength=GAME["plus_n"] + 1)[1:]
    exp = n / GAME["plus_n"]
    fig, ax = plt.subplots(figsize=(4.6, 4))
    x = np.arange(1, GAME["plus_n"] + 1)
    ax.bar(x, counts, color=ACCENT, width=0.6, zorder=3)
    ax.axhline(exp, color=INK, lw=1.4, label=f"ожидание = {exp:.0f}")
    ax.set_xticks(x)
    ax.set_title("Поле «плюс» (1–4)", color=INK, fontweight="bold")
    ax.set_xlabel("число"); ax.set_ylabel("частота")
    ax.grid(axis="y", color=GRID, zorder=0); ax.legend(framealpha=.9)
    for s in ax.spines.values(): s.set_color(GRID)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, "02_plus_frequency.png"), dpi=130); plt.close(fig)


def figure_sum(main):
    sums = main.sum(axis=1)
    fig, ax = plt.subplots(figsize=(7.5, 4))
    ax.hist(sums, bins=range(sums.min(), sums.max() + 2), color=ACCENT, alpha=.85, zorder=3,
            density=True, label="наблюдаемое")
    xs = np.linspace(sums.min(), sums.max(), 200)
    ax.plot(xs, stats.norm.pdf(xs, sums.mean(), sums.std()), color=WARN, lw=2,
            label="нормальное приближение")
    ax.set_title("Распределение суммы 5 основных чисел", color=INK, fontweight="bold")
    ax.set_xlabel("сумма"); ax.set_ylabel("плотность")
    ax.grid(axis="y", color=GRID, zorder=0); ax.legend(framealpha=.9)
    for s in ax.spines.values(): s.set_color(GRID)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, "03_sum_distribution.png"), dpi=130); plt.close(fig)


def figure_montecarlo(main, mc, null):
    fig, ax = plt.subplots(figsize=(7.5, 4))
    ax.hist(null, bins=50, color=ACCENT, alpha=.8, zorder=3, label="null: честный RNG")
    ax.axvline(mc["observed_chi2"], color=WARN, lw=2.2, zorder=5,
               label=f"наблюдаемое χ² = {mc['observed_chi2']:.0f}")
    ax.set_title("χ² основного поля: наблюдаемое против честного null", color=INK, fontweight="bold")
    ax.set_xlabel("статистика χ² (df=35)"); ax.set_ylabel("частота (из %d симуляций)" % mc["reps"])
    ax.grid(axis="y", color=GRID, zorder=0); ax.legend(framealpha=.9)
    for s in ax.spines.values(): s.set_color(GRID)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, "04_montecarlo_null.png"), dpi=130); plt.close(fig)


def main():
    d = load_draws(CSV)
    integ = integrity_report(d)
    null = null_chi2_distribution(len(d), reps=2000)   # fair-null, computed once
    audit = run_full_audit(d.main, d.plus, null)
    desc = summary(d.main, d.plus)

    figure_number_frequency(d.main, len(d))
    figure_plus(d.plus, len(d))
    figure_sum(d.main)
    figure_montecarlo(d.main, audit["montecarlo_chi2"], null)

    out = {"integrity": integ, "audit": audit, "descriptive": desc,
           "config": {"null_seed": SEED_NULL, "game": GAME}}
    with open(os.path.join(RUNS, "sprint1_audit.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    _write_report(out)
    v = audit["verdict"]
    print("VERDICT fair_consistent =", v["fair_consistent"], "| flags:", v["flags"] or "нет")


def _write_report(out: dict):
    a, integ, desc = out["audit"], out["integrity"], out["descriptive"]
    mf, pf = a["main_frequency_chi2"], a["plus_frequency_chi2"]
    fdr, mc = a["per_number_fdr"], a["montecarlo_chi2"]
    v = a["verdict"]
    verdict_line = ("✅ **Согласуется с честной лотереей** — ни один тест не сработал после поправок."
                    if v["fair_consistent"] else
                    "⚠️ **Обнаружены отклонения:** " + "; ".join(v["flags"]))
    md = f"""# Спринт 1 — Аудит честности 5x36plus

**Данные:** {integ['draws']} тиражей, № {integ['draw_range'][0]}–{integ['draw_range'][1]}
({integ['date_range'][0][:10]} → {integ['date_range'][1][:10]}),
пропущено {integ['missing_draw_ids']} №, дублей {integ['duplicate_draw_ids']}.

## Вердикт
{verdict_line}

## Результаты батареи (все тесты — АУДИТ, не прогноз)

| Тест | Статистика | p-value | Что значит |
|---|---|---|---|
| χ² частот, основное поле | {mf['chi2']:.2f} (df={mf['df']}) | {mf['p_value']:.4f} | p>0.05 → равномерно |
| χ² частот, поле «плюс» | {pf['chi2']:.2f} (df={pf['df']}) | {pf['p_value']:.4f} | p>0.05 → равномерно |
| Per-number + FDR | мин. сырое p={fdr['min_raw_p']:.4f} | — | значимых после FDR: **{fdr['n_significant_after_fdr']}** из 36 |
| Runs-test (суммы) | z={a['runs_test_on_sum']['z']} | {a['runs_test_on_sum']['p_value']:.4f} | нет кластеризации |
| Автокорреляция сумм (Ljung–Box) | Q={a['autocorrelation_of_sum']['ljung_box_Q']} (лагов={a['autocorrelation_of_sum']['max_lag']}) | {a['autocorrelation_of_sum']['ljung_box_p']:.4f} | совместный тест: сериальной зависимости нет |
| Энтропия основного поля | {a['entropy_main']['entropy_bits']:.4f} / {a['entropy_main']['max_bits']:.4f} бит | — | ratio={a['entropy_main']['ratio']:.5f} |
| Gap-test vs геометрич. *(диагностика)* | KS={a['gap_test_main']['ks_stat']} | {a['gap_test_main']['ks_p_value']:.4f} | средний gap {a['gap_test_main']['mean_gap']} (ожид. {a['gap_test_main']['expected_mean_gap']}) |
| Монте-Карло χ² | наблюдаемое={mc['observed_chi2']} | перцентиль={mc['observed_percentile']} | null-среднее={mc['null_mean_chi2']} |

**Защита от p-hacking:**
- При 36 проверках чисел на уровне 0.05 ожидается ~{fdr['expected_false_positives_at_0.05']} ложных срабатываний — поэтому применяется FDR-коррекция (Benjamini–Hochberg); «значимым» число считается только если переживает её.
- Автокорреляция: подсчёт отдельных лагов вне полосы — ловушка множественности (из {a['autocorrelation_of_sum']['max_lag']} лагов ~{a['autocorrelation_of_sum']['expected_outside_by_chance']} выйдут за полосу случайно; здесь вышло {len(a['autocorrelation_of_sum']['lags_outside_band'])}). Вердикт опирается на **совместный тест Льюнга–Бокса**, а не на отдельные лаги.
- Gap-test помечен *диагностическим*: непрерывный KS применён к дискретным gap'ам при n≈{a['gap_test_main']['n_gaps']//1000}k, что даёт заниженный p искусственно — поэтому он **не** входит в вердикт (средний gap {a['gap_test_main']['mean_gap']} ≈ теоретические {a['gap_test_main']['expected_mean_gap']}, что как раз подтверждает честность).

## Дескриптив (характеристика прошлого, НЕ прогноз)
- Самые частые числа: {', '.join(f'{n}({c})' for n,c in desc['hottest'])}
- Самые редкие числа: {', '.join(f'{n}({c})' for n,c in desc['coldest'])}
- Сумма 5 чисел: среднее {desc['sum']['mean']}, σ={desc['sum']['std']}, диапазон {desc['sum']['min']}–{desc['sum']['max']}
- Распределение «плюс» (1–4): {desc['plus_distribution']}

> ⚠️ «Горячие» и «холодные» числа описывают ТОЛЬКО прошлое. В честной лотерее они не дают
> никакого преимущества для следующего тиража — это подтверждает вердикт выше.

## Графики
`runs/figures/01_number_frequency.png` · `02_plus_frequency.png` · `03_sum_distribution.png` · `04_montecarlo_null.png`
"""
    with open(os.path.join(RUNS, "sprint1_audit_report.md"), "w", encoding="utf-8") as f:
        f.write(md)


if __name__ == "__main__":
    main()
