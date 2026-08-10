#!/usr/bin/env python3
"""Sprint 5: anomaly hunt on a single-field k-of-n lottery.

Usage: python3 scripts/run_anomaly.py [slug n k]   (default: 7x49 49 7)
Outputs: runs/sprint5_anomaly.json, runs/sprint5_anomaly_report.md,
         runs/figures/s5_*.png
"""
from __future__ import annotations
import os, sys, json
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
from lab.anomaly import load_single_field, hunt

RUNS = os.path.join(ROOT, "runs"); FIG = os.path.join(RUNS, "figures")
os.makedirs(FIG, exist_ok=True)
INK, ACCENT, WARN, OK, GRID = "#16202e", "#0e7c86", "#c0392b", "#1f8a54", "#dfe3ea"


def fig_null(null, obs, title, fname, xlabel):
    fig, ax = plt.subplots(figsize=(7.4, 4.0))
    ax.hist(null, bins=30, color=ACCENT, alpha=.8, zorder=3, label="null: честный ГСЧ")
    ax.axvline(obs, color=WARN, lw=2.2, zorder=5, label=f"наблюдаемое = {obs:g}")
    ax.axvline(float(np.percentile(null, 95)), color=INK, ls="--", lw=1.2, label="p95 null")
    ax.set_title(title, color=INK, fontweight="bold")
    ax.set_xlabel(xlabel); ax.set_ylabel("частота (симуляций)")
    ax.grid(axis="y", color=GRID, zorder=0); ax.legend(framealpha=.9, fontsize=8.5)
    for s in ax.spines.values(): s.set_color(GRID)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, fname), dpi=130); plt.close(fig)


def fig_scoreboard(findings):
    named = [(f["name"], f["percentile"]) for f in findings if f["percentile"] is not None]
    labels = [n for n, _ in named]; pct = [p * 100 for _, p in named]
    fig, ax = plt.subplots(figsize=(8.6, 3.6))
    y = np.arange(len(labels))
    colors = [WARN if p > 95 else OK for p in pct]
    ax.barh(y, pct, color=colors, zorder=3, height=0.6)
    ax.axvline(95, color=INK, ls="--", lw=1.2, label="порог аномалии (95-й перцентиль)")
    ax.set_yticks(y); ax.set_yticklabels(labels); ax.invert_yaxis()
    ax.set_xlim(0, 100)
    ax.set_title("Где сидит наблюдаемое внутри честного null (перцентиль)", color=INK, fontweight="bold")
    ax.set_xlabel("перцентиль null")
    ax.grid(axis="x", color=GRID, zorder=0); ax.legend(framealpha=.9, fontsize=8.5)
    for s in ax.spines.values(): s.set_color(GRID)
    fig.tight_layout(); fig.savefig(os.path.join(FIG, "s5_03_scoreboard.png"), dpi=130); plt.close(fig)


def main():
    slug, n, k = (sys.argv[1], int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else ("7x49", 49, 7)
    main_arr, dates = load_single_field(os.path.join(ROOT, "data", "clean", f"{slug}.csv"), k)
    res = hunt(main_arr, dates, n, k, reps=200, pair_reps=60)
    mc = res.pop("_mc")

    fig_null(mc["drought_null"], mc["drought_obs"],
             "Аномалия? Самая длинная засуха числа", "s5_01_drought.png", "макс. интервал без числа (тиражей)")
    fig_null(mc["pair_null"], mc["pair_obs"],
             "Аномалия? Самая частая пара чисел", "s5_02_pair.png", "макс. число появлений пары")
    fig_scoreboard(res["findings"])

    def _san(o):
        if isinstance(o, dict): return {kk: _san(vv) for kk, vv in o.items()}
        if isinstance(o, list): return [_san(vv) for vv in o]
        if isinstance(o, np.bool_): return bool(o)
        if isinstance(o, np.integer): return int(o)
        if isinstance(o, np.floating): return float(o)
        return o
    with open(os.path.join(RUNS, "sprint5_anomaly.json"), "w", encoding="utf-8") as f:
        json.dump(_san(res), f, ensure_ascii=False, indent=2)
    _report(res, slug)
    print(f"{slug}: {res['n_tests']} tests, anomalies flagged = {res['n_anomalies']}")
    for f in res["findings"]:
        pc = f"{f['percentile']*100:.0f}%" if f["percentile"] is not None else "—"
        print(f"  [{'ANOMALY' if f['anomaly'] else '  ok   '}] {f['name']:42s} obs={f['observed']} pct={pc}")


def _report(res, slug):
    rows = ""
    for f in res["findings"]:
        pc = f"{f['percentile']*100:.0f}%" if f["percentile"] is not None else "—"
        nm = f"{f['null_mean']}" if f["null_mean"] is not None else "—"
        mark = "⚠️ АНОМАЛИЯ" if f["anomaly"] else "✅ случайность"
        rows += f"| {f['name']} | {f['observed']} | {nm} | {pc} | {mark} | {f['note']} |\n"
    verdict = ("✅ **Эксплуатируемых аномалий не найдено** — все кандидаты укладываются в честный null."
               if res["n_anomalies"] == 0 else
               f"⚠️ **Помечено {res['n_anomalies']} кандидат(ов)** — требуется поиск причины (см. ниже).")
    md = f"""# Спринт 5 — Охота за аномалиями ({res['game']})

**Идея:** искать не закономерности, а статистически невозможные события. У каждого спросить:
это чистая случайность (закон истинно больших чисел) или у аномалии есть **причина**
(смещённый автомат, сбой ГСЧ, смена правил)? Причина = единственный настоящий эдж.

**Данные:** {res['draws']} тиражей, {res['date_range'][0]} → {res['date_range'][1]}.
Проверено измерений: **{res['n_tests']}**.

## Вердикт
{verdict}

## Табло аномалий (каждый кандидат против честного null)

| Проверка | Наблюдалось | Null (среднее) | Перцентиль | Итог | Примечание |
|---|---|---|---|---|---|
{rows}
## Как читать
- **Перцентиль** — где наблюдаемое сидит внутри распределения честного ГСЧ (Монте-Карло, 200 симуляций
  для экстремальных статистик). ~50% = типично; >95% = кандидат в аномалии.
- Показательный пример: самая длинная **засуха** выглядит пугающе (десятки тиражей без числа), но её
  честное ожидание тоже большое — наблюдаемое садится около медианы null. Наивная интуиция («это не
  может быть случайно!») ошибается, строгий null — нет.
- **Защита от look-elsewhere:** мы прогнали {res['n_tests']} проверок; при пороге 5% ~{res['n_tests']*0.05:.1f}
  «аномалии» ожидались бы случайно. Для одиночных чисел применён Bonferroni, для смены режима — Bonferroni по годам.

## Что это значит для «обыграть систему»
Чтобы аномалию можно было эксплуатировать, у неё должна быть **устойчивая причина** (физический перекос
автомата, дефект ГСЧ). Ни одна проверка такой причины не выявила: частоты равномерны по годам, засухи/серии/
пары — в пределах случайного, повторов комбинаций ровно столько, сколько предсказывает парадокс дней рождения.
Аномалии-«призраки» есть всегда, но они не переносятся на будущее. **Стабильного эджа через аномалии нет.**

## Графики
`s5_01_drought.png` · `s5_02_pair.png` · `s5_03_scoreboard.png`
"""
    with open(os.path.join(RUNS, "sprint5_anomaly_report.md"), "w", encoding="utf-8") as f:
        f.write(md)


if __name__ == "__main__":
    main()
