#!/usr/bin/env python3
"""Сжимает полную выгрузку отзывов в компактную сводку для агента.

Агенту не нужны 10 000 отзывов: ему нужны
  - сводка периода (сколько, оценки),
  - отзывы периода, требующие внимания: без ответа или с оценкой 1–3,
  - история по тем же артикулам: агрегаты за весь срок выгрузки и негативные отзывы (1–3★)
    вне периода — для проверки гипотез «проблема новая или давняя».
Сеть не использует. Пример:
    python3 agents/review-analyst/tools/build_brief.py agents/review-analyst/data/wb-feedbacks-2026-11-18.json
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

TEXT_MAX = 400          # обрезка длинных текстов
HISTORY_NEG_MAX = 15    # не больше N негативных отзывов истории на артикул


def trim(s: str) -> str:
    return s if len(s) <= TEXT_MAX else s[:TEXT_MAX] + "…"


def slim(r: dict) -> dict:
    out = {k: r[k] for k in ("review_id", "date", "rating", "buyer", "size_match", "photos", "videos", "status")}
    out.update(text=trim(r["text"]), pros=trim(r["pros"]), cons=trim(r["cons"]),
               product_id=r["product"]["product_id"], product=r["product"]["name"],
               supplier_article=r["product"].get("supplier_article"))
    if r["answer"]:
        out["answer"] = trim(r["answer"].get("text") or "")
    return out


def main():
    src = Path(sys.argv[1])
    d = json.loads(src.read_text(encoding="utf-8"))
    rows = d["rows"]
    period = [r for r in rows if r["in_period"]]
    focus = [r for r in period if r["status"] == "unanswered" or (r["rating"] or 5) <= 3]
    focus_ids = {r["product"]["product_id"] for r in focus}

    by_prod = defaultdict(list)
    for r in rows:
        by_prod[r["product"]["product_id"]].append(r)

    history = {}
    for pid in sorted(focus_ids, key=str):
        all_r = by_prod[pid]
        neg_out = [r for r in all_r if not r["in_period"] and (r["rating"] or 5) <= 3]
        history[str(pid)] = {
            "product": all_r[0]["product"]["name"],
            "reviews_total": len(all_r),
            "avg_rating": round(sum(r["rating"] or 0 for r in all_r) / len(all_r), 2),
            "ratings": dict(sorted(Counter(r["rating"] for r in all_r).items())),
            "negative_outside_period_total": len(neg_out),
            "negative_outside_period": [
                {"date": r["date"], "rating": r["rating"], "text": trim(r["text"]), "cons": trim(r["cons"]),
                 "size_match": r["size_match"]}
                for r in neg_out[:HISTORY_NEG_MAX]],
        }

    rc = Counter(r["rating"] for r in period)
    brief = {
        "_note": "Сводка для агента review-analyst. Содержит имена покупателей — не коммитить.",
        "source": "wb-api",
        "period": d["period"],
        "history_from": d["history_from"],
        "period_summary": {
            "total": len(period),
            "unanswered": sum(r["status"] == "unanswered" for r in period),
            "avg_rating": round(sum(r["rating"] or 0 for r in period) / len(period), 2) if period else None,
            "ratings": dict(sorted(rc.items())),
            "products": len({r["product"]["product_id"] for r in period}),
        },
        "rows_note": "rows — только отзывы периода без ответа или с оценкой 1–3; остальные (4–5★ с ответом) учтены лишь в period_summary.",
        "rows": [dict(slim(r), in_period=True) for r in focus],
        "history_by_product": history,
    }
    out = src.with_name(src.name.replace("wb-feedbacks-", "wb-brief-"))
    out.write_text(json.dumps(brief, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Сохранено: {out} ({out.stat().st_size // 1024} КБ); отзывов в фокусе: {len(focus)}; артикулов: {len(focus_ids)}")


if __name__ == "__main__":
    main()
