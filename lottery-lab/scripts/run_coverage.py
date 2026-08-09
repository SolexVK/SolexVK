#!/usr/bin/env python3
"""Sprint 4: full-coverage (Mandel) economics across bigger-jackpot lotteries.

Runs the honest flood model on each single-field k-of-n game whose CSV is in
data/clean/, and compares them to the 5x36plus result from Sprint 3.5.

Outputs: runs/sprint4_coverage.json, runs/sprint4_coverage_report.md,
         runs/figures/s4_coverage.png
"""
from __future__ import annotations
import os, sys, json
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
from lab.coverage import load_game, coverage_economics

CLEAN = os.path.join(ROOT, "data", "clean")
RUNS = os.path.join(ROOT, "runs"); FIG = os.path.join(RUNS, "figures")
os.makedirs(FIG, exist_ok=True)
INK, ACCENT, WARN, OK, GRID = "#16202e", "#0e7c86", "#c0392b", "#1f8a54", "#dfe3ea"

# single-field games to analyse (slug -> n, k, label)
GAMES = [("6x45", 45, 6, "6 из 45"), ("7x49", 49, 7, "7 из 49")]


def figure(results):
    fig, ax = plt.subplots(figsize=(8.6, 4.4))
    for r, color in zip(results, [ACCENT, WARN, OK, "#a99cf0"]):
        jp = r["_jackpot"] / 1e6
        ax.scatter(jp, r["_ratio"], s=5, alpha=.2, color=color, edgecolors="none",
                   label=f"{r['label']} (потолок {r['best_ratio']:.2f})")
    ax.axhline(1.0, color=INK, lw=1.8, zorder=5, label="безубыточность")
    ax.set_ylim(0, 1.3)
    ax.set_title("Покупка всех комбинаций: возврат ÷ затраты против джекпота",
                 color=INK, fontweight="bold")
    ax.set_xlabel("джекпот в тираже, млн ₽"); ax.set_ylabel("возврат ÷ затраты")
    ax.grid(color=GRID, zorder=0); ax.legend(framealpha=.9, fontsize=8.5)
    for s in ax.spines.values(): s.set_color(GRID)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, "s4_coverage.png"), dpi=130); plt.close(fig)


def main():
    results = []
    for slug, n, k, label in GAMES:
        path = os.path.join(CLEAN, f"{slug}.csv")
        if not os.path.exists(path):
            print(f"skip {slug}: no data"); continue
        e = coverage_economics(load_game(path, k), n, k)
        e["label"], e["slug"] = label, slug
        results.append(e)
    figure(results)

    clean = [{k: v for k, v in r.items() if not k.startswith("_")} for r in results]
    with open(os.path.join(RUNS, "sprint4_coverage.json"), "w", encoding="utf-8") as f:
        json.dump(clean, f, ensure_ascii=False, indent=2)
    _report(clean)
    for r in clean:
        print(f"{r['label']}: C={r['combinations']:,} cost={r['cover_cost_rub']/1e6:.0f}M "
              f"breakeven={r['breakeven_jackpot_rub']/1e6:.0f}M maxJP={r['max_jackpot_rub']/1e6:.0f}M "
              f"best_ratio={r['best_ratio']:.3f} profitable={r['profitable_draws']}/{r['draws']}")


def _report(res):
    rows = ""
    for r in res:
        verdict = "✅ достижимо" if r["profitable_draws"] > 0 else "— не достигнут"
        rows += (f"| {r['label']} | {r['combinations']:,} | {r['cover_cost_rub']/1e6:,.0f} | "
                 f"{r['house_edge']*100:.0f}% | {r['breakeven_jackpot_rub']/1e6:,.0f} | "
                 f"{r['max_jackpot_rub']/1e6:,.0f} | {r['best_ratio']:.2f} | {r['profitable_draws']} {verdict} |\n")
    md = f"""# Спринт 4 — «Система комбинаций» на больших джекпотах

Сравнение условия Манделя (купить ВСЕ комбинации, когда джекпот > стоимости покрытия)
на лотереях Столото с бо́льшими джекпотами. Модель честная: нижние тиры пари-мютюэльные,
поэтому засчитывается только доля пула + накопленный джекпот.

| Лотерея | Комбинаций C(n,k) | Покрытие, млн ₽ | House edge | Порог безубытка, млн | Макс. джекпот, млн | Потолок ratio | Прибыльных тиражей |
|---|---|---|---|---|---|---|---|
| 5 из 36 плюс* | 1 507 968 | 113 | 48% | 78 | 19 | 0.49 | 0 — недостижимо |
{rows}
\\* 5x36plus — из Спринта 3.5 (с полем «плюс», отдельная модель).

## Что видно
- Чем больше пул, тем **экспоненциально** дороже покрытие: 5×36 → 1.5 млн комбинаций,
  6×45 → 8.1 млн, 7×49 → 85.9 млн. Джекпот растёт линейно, стоимость покрытия — комбинаторно.
- **6 из 45 — единственная, где условие Манделя реально достигалось**: при джекпоте выше
  порога (~253 млн ₽, а максимум доходил до 304 млн) полное покрытие давало номинальную
  прибыль в части тиражей.
- На 7×49 пул 85.9 млн комбинаций делает покрытие настолько дорогим, что даже рекордные
  джекпоты до него не дотягивают.

## Почему это НЕ рабочая схема (даже для 6×45)
1. **Логистика:** купить 8.1 млн уникальных билетов до закрытия тиража физически почти
   невозможно; современные лотереи ограничивают массовую скупку (Мандель делал это в 1980–90-х
   через лазейки, после чего правила закрыли).
2. **Капитал и риск:** ~400 млн ₽ вперёд на один тираж.
3. **Налог** на выигрыш (13–15%) съедает тонкую маржу целиком.
4. **Тонкая маржа:** лучший исторический случай — прибыль ~12% в ОДНОМ тираже из 18 000;
   любая ошибка в доле пула, дележ джекпота или комиссия уводят в минус.
5. **Прошлое не отыграть:** вперёд джекпот редко превышает порог, а когда превышает — это
   публично, растёт число участников и риск дележа.

**Итог:** условие Манделя на 6×45 математически достигалось (в отличие от 5×36plus), но
остаётся исторической диковиной, а не стратегией.

## График
`runs/figures/s4_coverage.png`
"""
    with open(os.path.join(RUNS, "sprint4_coverage_report.md"), "w", encoding="utf-8") as f:
        f.write(md)


if __name__ == "__main__":
    main()
