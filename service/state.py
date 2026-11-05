"""What the panel shows: one dict built from the files in trader/ plus the scheduler.
Pure reading, no network. The same numbers the bot prints, in one place."""

import datetime
import json
import os


def _f(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def positions_with_pnl(pack):
    """Each position: shares, cost basis (from the lots), price, value, pnl, share of total."""
    pf = pack.read("trader/portfolio.json", {}) or {}
    pdoc = pack.read("trader/prices.json", {}) or {}
    prices = pdoc.get("prices", {}) or {}
    cash = _f(pf.get("cash"))
    rows = []
    for p in pf.get("positions", []):
        t = str(p.get("ticker", "")).upper()
        if not t:
            continue
        shares = _f(p.get("shares"))
        cost = sum(_f(l.get("cost")) for l in p.get("lots", []) or [])
        px = prices.get(t)
        value = shares * _f(px) if px is not None else cost
        pnl = value - cost if px is not None else 0.0
        rows.append({"ticker": t, "shares": shares, "cost": round(cost, 2), "avg": round(cost / shares, 2) if shares else None,
                     "price": _f(px) if px is not None else None, "value": round(value, 2), "pnl": round(pnl, 2),
                     "pnl_pct": round(100.0 * pnl / cost, 2) if cost else None,
                     "lots": len(p.get("lots", []) or []), "priced": px is not None})
    total = cash + sum(r["value"] for r in rows)
    for r in rows:
        r["share_pct"] = round(100.0 * r["value"] / total, 2) if total else 0.0
    rows.sort(key=lambda r: -r["value"])
    invested = sum(r["cost"] for r in rows)
    return {"cash": round(cash, 2), "total": round(total, 2), "invested": round(invested, 2),
            "pnl": round(sum(r["pnl"] for r in rows), 2), "positions": rows,
            "prices_as_of": pdoc.get("as_of"), "prices_source": pdoc.get("source"),
            "portfolio_as_of": pf.get("as_of"), "account_id": pf.get("account_id")}


def targets_vs_actual(pack, snapshot):
    tg = pack.read("trader/targets.json", {}) or {}
    weights = tg.get("weights", [])
    if isinstance(weights, dict):
        weights = [{"ticker": k, "weight": v} for k, v in weights.items()]
    actual = {r["ticker"]: r["share_pct"] for r in snapshot["positions"]}
    rows, seen = [], set()
    for w in weights:
        t = str(w.get("ticker", "")).upper()
        if not t:
            continue
        seen.add(t)
        rows.append({"ticker": t, "target": _f(w.get("weight")), "actual": actual.get(t, 0.0),
                     "drift": round(actual.get(t, 0.0) - _f(w.get("weight")), 2), "name": w.get("name", "")})
    for t, a in actual.items():
        if t not in seen:
            rows.append({"ticker": t, "target": 0.0, "actual": a, "drift": round(a, 2), "name": "", "untracked": True})
    return {"source": tg.get("source"), "why": tg.get("why"), "as_of": tg.get("as_of") or tg.get("taken_at"),
            "rows": rows, "inbox": os.path.isfile(pack.path("trader/inbox/targets.json"))}


def history(pack, days=120):
    rows = []
    p = pack.path("trader/state/history.jsonl")
    if os.path.isfile(p):
        with open(p, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue
    return rows[-days * 4:]


def record_history(pack, now=None, label=""):
    """Append the portfolio's value now to trader/state/history.jsonl (one line per record)."""
    now = now or datetime.datetime.now()
    snap = positions_with_pnl(pack)
    row = {"at": now.replace(microsecond=0).isoformat(), "label": label, "total": snap["total"], "cash": snap["cash"],
           "invested": snap["invested"], "pnl": snap["pnl"],
           "positions": {r["ticker"]: {"shares": r["shares"], "price": r["price"], "value": r["value"]} for r in snap["positions"]}}
    p = pack.path("trader/state/history.jsonl")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return row


def decisions(pack, limit=30):
    st = pack.read("trader/state/broker.json", {}) or {}
    rows = list(st.get("orders", []))[-limit:]
    rows.reverse()
    return rows


def tickets_cached(pack, cache, ttl=30):
    """Tickets cost a subprocess; keep them for a few seconds."""
    now = datetime.datetime.now().timestamp()
    if cache.get("at", 0) + ttl > now:
        return cache.get("tickets", [])
    try:
        tickets = pack.tickets()
    except Exception as exc:  # no orders yet, or no risk check
        tickets = []
        cache["error"] = str(exc)[:200]
    cache.update({"at": now, "tickets": tickets})
    return tickets


def build_state(pack, scheduler=None, cache=None):
    cfg = pack.config()
    snap = positions_with_pnl(pack)
    hist = history(pack)
    day = pack.read("trader/state/day.json", {}) or {}
    day_start = _f(day.get("start_total")) if day.get("date") == datetime.date.today().isoformat() else None
    out = {
        "generated_at": datetime.datetime.now().replace(microsecond=0).isoformat(),
        "env": "sandbox" if cfg.get("paper", True) else "live",
        "broker": cfg.get("broker"), "currency": cfg.get("currency", "RUB"), "account_id": cfg.get("account_id"),
        "limits": {k: cfg.get(k) for k in ("budget", "cash_buffer_pct", "max_position_pct", "max_order_usd",
                                            "min_order_usd", "max_orders_per_day")},
        "halt": pack.halted(),
        "portfolio": snap,
        "day": {"start_total": day_start,
                "change": round(snap["total"] - day_start, 2) if day_start else None,
                "change_pct": round(100.0 * (snap["total"] / day_start - 1), 2) if day_start else None},
        "targets": targets_vs_actual(pack, snap),
        "history": hist,
        "decisions": decisions(pack),
        "tickets": tickets_cached(pack, cache if cache is not None else {}),
        "jobs": [], "market_open": None,
        "news_last": (pack.read("trader/state/moex_news_job.json", {}) or {}).get("last_check"),
    }
    sched = pack.read("trader/state/schedule.json", {}) or {}
    out["schedule_today"] = (sched.get("days") or {}).get(datetime.date.today().isoformat())
    if scheduler is not None:
        out["market_open"] = scheduler.market_open()
        for j in scheduler.jobs:
            last = scheduler.last.get(j["name"])
            out["jobs"].append({"name": j["name"], "every_min": j.get("every_min"), "at": j.get("at"),
                                "last": last.isoformat() if last and j["name"] not in scheduler.skipped else None,
                                "result": scheduler.last_result.get(j["name"], "")})
    return out
