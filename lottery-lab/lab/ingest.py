"""Stoloto archive ingester (reverse-engineered mobile API).

Endpoint discovered from the site's Next.js bundles:
    GET https://www.stoloto.ru/p/api/mobile/api/v35/service/draws/archive
    params:  game=<slug>&count=50&page=<n>   (count caps at 50 server-side)
    headers: Device-Type: STOLOTO
             Gosloto-Partner: <token embedded in the JS bundle>

The endpoint serves the most recent draws and caps depth (~page 501 -> ~25k
draws for 5x36plus). Date filters are ignored server-side. For deeper history,
plug a secondary source into `SECONDARY_SOURCES` (see README).

Polite by design: sequential, small delay, retry with backoff.
"""
from __future__ import annotations
import json, time, urllib.request

BASE = "https://www.stoloto.ru/p/api/mobile/api/v35/service/draws/archive"
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://www.stoloto.ru/5x36plus/archive",
    "Device-Type": "STOLOTO",
    "Gosloto-Partner": "bXMjXFRXZ3coWXh6R3s1NTdUX3dnWlBMLUxmdg",
}


def _fetch(game: str, page: int, count: int = 50, retries: int = 4) -> dict:
    url = f"{BASE}?game={game}&count={count}&page={page}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def download_all(game: str = "5x36plus", delay: float = 0.12, max_pages: int = 700):
    """Page through the archive until the server stops serving older draws.
    Returns a de-duplicated list of raw draw objects, oldest-first."""
    draws, prev_first, page = {}, None, 1
    while page <= max_pages:
        arr = _fetch(game, page).get("draws", [])
        if not arr:
            break
        first = arr[0]["number"]
        if first == prev_first:      # depth cap reached: page no longer advances
            break
        prev_first = first
        for x in arr:
            draws[x["number"]] = x
        page += 1
        time.sleep(delay)
    return sorted(draws.values(), key=lambda x: x["number"])
