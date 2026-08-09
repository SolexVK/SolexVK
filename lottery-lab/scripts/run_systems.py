#!/usr/bin/env python3
"""Sprint 3.5: can a SYSTEM of combinations beat one draw? (H030)

Outputs: runs/sprint35_systems.json, runs/sprint35_systems_report.md,
         runs/figures/s35_fullcover.png
"""
from __future__ import annotations
import os, sys, json
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
from lab.payout import load_payout
from lab.systems import full_cover

PAY = os.path.join(ROOT, "data", "clean", "5x36plus_payout.csv")
RUNS = os.path.join(ROOT, "runs"); FIG = os.path.join(RUNS, "figures")
os.makedirs(FIG, exist_ok=True)
INK, ACCENT, WARN, OK, GRID = "#16202e", "#0e7c86", "#c0392b", "#1f8a54", "#dfe3ea"


def figure(fc):
    ratio, jp = fc["_ratio"], fc["_jackpot"] / 1e6
    fig, ax = plt.subplots(figsize=(8.4, 4.4))
    ax.scatter(jp, ratio, s=6, alpha=.25, color=ACCENT, zorder=3, edgecolors="none")
    ax.axhline(1.0, color=WARN, lw=1.8, zorder=4, label="безубыточность (return = cost)")
    ax.axhline(fc["best_return_over_cost"], color=INK, ls="--", lw=1.2,
               label=f"потолок = {fc['best_return_over_cost']:.2f} (всегда убыток)")
    ax.set_ylim(0, 1.15)
    ax.set_title("Покупка ВСЕХ комбинаций: возврат ÷ затраты по каждому тиражу",
                 color=INK, fontweight="bold")
    ax.set_xlabel("джекпот СУПЕР №1 в тираже, млн ₽"); ax.set_ylabel("возврат ÷ затраты")
    ax.grid(color=GRID, zorder=0); ax.legend(framealpha=.9)
    for s in ax.spines.values(): s.set_color(GRID)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, "s35_fullcover.png"), dpi=130); plt.close(fig)


def main():
    fc = full_cover(load_payout(PAY))
    figure(fc)
    out = {k: v for k, v in fc.items() if not k.startswith("_")}
    with open(os.path.join(RUNS, "sprint35_systems.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    md = f"""# Спринт 3.5 — Система комбинаций на один тираж (H030)

**Вопрос:** даёт ли преимущество запуск не одного билета, а системы комбинаций
(вплоть до покупки ВСЕХ вариантов) на один розыгрыш? Были ли выгодные случаи в архиве?

## Короткий ответ: НЕТ — ни в одном из {out['n_draws']:,} тиражей.

Чтобы гарантированно взять СУПЕР №1, нужно купить **все {out['tickets_to_cover']:,} комбинаций**
(≈{out['cost_at_75']/1e6:.0f} млн ₽ при цене 75 ₽). Тогда ты выигрываешь джекпот И фиксированный
комбинаторный набор всех нижних призов. Итог по архиву:

| Показатель | Значение |
|---|---|
| Средний возврат ÷ затраты | **{out['mean_return_over_cost']:.3f}** (гарантированный убыток {(1-out['mean_return_over_cost'])*100:.0f}%) |
| **Лучший тираж в истории** | ратио **{out['best_return_over_cost']:.3f}** — всё равно убыток {(1-out['best_return_over_cost'])*100:.0f}% |
| Прибыльных тиражей (ратио>1) | **{out['profitable_draws']} из {out['n_draws']:,}** |
| Убыток в лучшем случае | **{out['best_pl_rub']/1e6:.0f} млн ₽** на вложенные {out['cost_at_75']/1e6:.0f} млн |
| Джекпот для безубытка | ≈**{out['breakeven_jackpot_rub']/1e6:.0f} млн ₽** |
| Максимальный джекпот за историю | {out['max_jackpot_rub']/1e6:.1f} млн ₽ |

Потолок джекпота ({out['max_jackpot_rub']/1e6:.1f} млн) вчетверо ниже порога безубытка ({out['breakeven_jackpot_rub']/1e6:.0f} млн).
Поэтому «система Манделя» здесь структурно невозможна.

## Почему система в принципе не меняет ожидание
EV **линеен по ставке**: сколько бы комбинаций ты ни покрыл, возвращается один и тот же
процент (RTP ≈ 52%, house edge ≈ 48%). Системы (веера/wheeling) меняют **форму риска** —
дают гарантии мелких категорий и снижают дисперсию — но не средний результат. Единственная
лазейка (купить всё, когда джекпот > стоимости покрытия) на 5x36plus не открывается никогда.

## Исторические исключения (и почему тут не работают)
- **Стефан Мандель** выигрывал именно так — но в лотереях, где джекпот ПРЕВЫШАЛ стоимость
  покупки всех билетов. Здесь потолок джекпота в 4 раза ниже этой стоимости.
- **Джерри Селби / Cash WinFall** — эксплуатировали «rolldown» (структурный дефект правил:
  джекпот при переполнении перетекал в нижние тиры, делая EV положительным). В 5x36plus
  такого механизма нет — что подтвердил Спринт 2 (положительного EV не бывает).

## График
`runs/figures/s35_fullcover.png` — облако «возврат ÷ затраты» по всем тиражам упирается в потолок {out['best_return_over_cost']:.2f}, красная линия безубытка недостижима.
"""
    with open(os.path.join(RUNS, "sprint35_systems_report.md"), "w", encoding="utf-8") as f:
        f.write(md)
    print(f"full-cover: mean ratio={out['mean_return_over_cost']:.3f} best={out['best_return_over_cost']:.3f} "
          f"profitable={out['profitable_draws']}/{out['n_draws']} breakeven={out['breakeven_jackpot_rub']/1e6:.0f}M vs max {out['max_jackpot_rub']/1e6:.1f}M")


if __name__ == "__main__":
    main()
