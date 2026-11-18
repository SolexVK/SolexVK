#!/usr/bin/env python3
"""Загрузка отзывов WB для агента review-analyst. ТОЛЬКО ЧТЕНИЕ.

Делает лишь GET-запросы к feedbacks-api.wildberries.ru и сохраняет отзывы
в JSON в формате тестовых данных агента. Ничего не публикует и не меняет.

Токен берётся из переменной окружения Wildberries_API и никуда не выводится.

Пример:
    python3 agents/review-analyst/tools/fetch_wb_feedbacks.py --period-days 7 --history-days 90
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = "https://feedbacks-api.wildberries.ru/api/v1/feedbacks"
PAGE = 5000          # максимум take у WB
MAX_SKIP = 199_990   # максимум skip у WB
MSK = timezone(timedelta(hours=3))

# Лимиты WB «Вопросы и отзывы»: 1 запрос/с на всю категорию, >3/с — блок на 60 с.
# Правила и источники: agents/_shared/api-limits.md
MIN_INTERVAL = 1.1
_last_call = 0.0
_wait_before_next = 0.0


def _throttle():
    global _last_call, _wait_before_next
    pause = max(MIN_INTERVAL - (time.monotonic() - _last_call), _wait_before_next, 0)
    if pause:
        time.sleep(pause)
    _wait_before_next = 0.0
    _last_call = time.monotonic()


def _header_int(headers, name, default):
    try:
        return int(float(headers.get(name)))
    except (TypeError, ValueError):
        return default


def get(params: dict, token: str, retries: int = 3) -> dict:
    global _wait_before_next
    url = f"{API}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Authorization": token}, method="GET")
    last = None
    for attempt in range(retries + 1):
        _throttle()
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                if _header_int(r.headers, "X-Ratelimit-Remaining", 1) <= 0:
                    _wait_before_next = _header_int(r.headers, "X-Ratelimit-Reset", 60)
                body = json.loads(r.read().decode("utf-8"))
            if body.get("error"):
                sys.exit(f"WB API вернул ошибку: {body.get('errorText')}")
            return body["data"]
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = _header_int(e.headers, "X-Ratelimit-Retry", 60)
                print(f"429 от WB: жду {wait} с (X-Ratelimit-Retry)", file=sys.stderr)
                _wait_before_next = wait
                last = "HTTP 429"
                continue
            if 400 <= e.code < 500:
                # 4xx повтором не лечатся и, возможно, дороже обычных запросов — не повторяем.
                hint = " Проверь токен Wildberries_API (категория «Вопросы и отзывы»)." if e.code in (401, 403) else ""
                sys.exit(f"WB API: HTTP {e.code}.{hint}")
            last = f"HTTP {e.code}"
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            last = str(e)
        _wait_before_next = 3 * (attempt + 1)
    sys.exit(f"WB API недоступен после {retries + 1} попыток: {last}")


def fetch(token: str, answered: bool, date_from: int, date_to: int) -> list:
    rows, skip = [], 0
    while True:
        data = get({"isAnswered": str(answered).lower(), "take": PAGE, "skip": skip,
                    "order": "dateDesc", "dateFrom": date_from, "dateTo": date_to}, token)
        batch = data.get("feedbacks") or []
        rows += batch
        if len(batch) < PAGE:
            return rows
        skip += PAGE
        if skip > MAX_SKIP:
            print(f"Достигнут предел skip={MAX_SKIP}: часть старых отзывов не загружена.", file=sys.stderr)
            return rows


def normalize(f: dict, period_start: str) -> dict:
    p = f.get("productDetails") or {}
    ans = f.get("answer")
    date = (f.get("createdDate") or "")[:10]
    return {
        "review_id": f.get("id"),
        "date": date,
        "in_period": date >= period_start,
        "rating": f.get("productValuation"),
        "text": f.get("text") or "",
        "pros": f.get("pros") or "",
        "cons": f.get("cons") or "",
        "buyer": f.get("userName") or "",
        "size_match": f.get("matchingSize"),
        "photos": len(f.get("photoLinks") or []),
        "videos": 1 if f.get("video") else 0,
        "product": {"product_id": p.get("nmId"), "name": p.get("productName"),
                    "supplier_article": p.get("supplierArticle"), "brand": p.get("brandName"),
                    "size": p.get("size")},
        "status": "answered" if ans else "unanswered",
        "answer": {"text": ans.get("text"), "state": ans.get("state")} if ans else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--period-days", type=int, default=7, help="анализируемый период")
    ap.add_argument("--history-days", type=int, default=90, help="история для проверки гипотез")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    token = os.environ.get("Wildberries_API")
    if not token:
        sys.exit("Нет переменной окружения Wildberries_API.")

    now = datetime.now(MSK)
    today = now.date()
    period_start = (today - timedelta(days=a.period_days - 1)).isoformat()
    hist_from = int((now - timedelta(days=a.history_days)).timestamp())
    to = int(now.timestamp())

    raw = fetch(token, False, hist_from, to) + fetch(token, True, hist_from, to)
    rows = sorted((normalize(f, period_start) for f in raw), key=lambda r: r["date"], reverse=True)

    out = Path(a.out or Path(__file__).resolve().parent.parent / "data" / f"wb-feedbacks-{today}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "_note": "Живые отзывы WB. Содержат имена покупателей — не коммитить.",
        "source": "wb-api",
        "period": {"date_from": period_start, "date_to": today.isoformat()},
        "history_from": (today - timedelta(days=a.history_days)).isoformat(),
        "rows": rows,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    in_p = [r for r in rows if r["in_period"]]
    print(f"Сохранено: {out}")
    print(f"Всего за историю: {len(rows)}; в периоде: {len(in_p)}; "
          f"без ответа в периоде: {sum(r['status'] == 'unanswered' for r in in_p)}")


if __name__ == "__main__":
    main()
