#!/usr/bin/env python3
"""Fundamentals for Moscow Exchange shares, from T-Invest API (trader-analyst, MOEX edition).

Reads GetAssetFundamentals (revenue, net income, EPS, margins, P/E, P/B, EV/EBITDA,
debt, dividends, growth, capitalisation) and writes one row per ticker into the
metrics file trader-screener reads, with the same column names facts.py uses for
US companies plus the extra MOEX columns.

    python3 moex_facts.py SBER LKOH GAZP                  # table, and trader/metrics.json
    python3 moex_facts.py --all                           # every RU share tradable via the API (hundreds)
    python3 moex_facts.py --all --sector energy            # one sector
    python3 moex_facts.py SBER --raw                       # the API's answer as is (to see units)
    python3 moex_facts.py SBER --dividends                 # dividends paid in the last 2 years
    python3 moex_facts.py SBER --json --no-write

Token: TINVEST_SANDBOX_TOKEN when trader/config.json says "paper": true (the
default), else TINVEST_TOKEN; a read-only token is enough. Never printed.
Numbers are the broker's data as published; this is reading, not advice.
"""

import argparse
import datetime
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load_tinvest():
    path = os.path.join(HERE, "..", "trader-tinvest", "tinvest.py")
    if not os.path.isfile(path):
        raise SystemExit("moex_facts.py: trader-tinvest/tinvest.py not found next to this skill")
    spec = importlib.util.spec_from_file_location("trader_tinvest", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# API field -> metrics column. Growth, margins and yields come as the API gives them.
MAP = [
    ("revenueTtm", "revenue_ttm"), ("netIncomeTtm", "net_income_ttm"), ("ebitdaTtm", "ebitda_ttm"),
    ("epsTtm", "eps_ttm"), ("dilutedEpsTtm", "diluted_eps_ttm"), ("freeCashFlowTtm", "free_cash_flow_ttm"),
    ("oneYearAnnualRevenueGrowthRate", "revenue_growth_yoy"),
    ("threeYearAnnualRevenueGrowthRate", "revenue_growth_3y"),
    ("fiveYearAnnualRevenueGrowthRate", "revenue_growth_5y"),
    ("netMarginMrq", "net_margin"), ("roe", "roe"), ("roa", "roa"), ("roic", "roic"),
    ("peRatioTtm", "pe"), ("priceToBookTtm", "pb"), ("priceToSalesTtm", "ps"),
    ("priceToFreeCashFlowTtm", "p_fcf"), ("evToEbitdaMrq", "ev_ebitda"), ("evToSales", "ev_sales"),
    ("totalDebtToEquityMrq", "debt_to_equity"), ("netDebtToEbitda", "net_debt_to_ebitda"),
    ("totalDebtToEbitdaMrq", "debt_to_ebitda"), ("currentRatioMrq", "current_ratio"),
    ("dividendYieldDailyTtm", "dividend_yield"), ("forwardAnnualDividendYield", "forward_dividend_yield"),
    ("dividendsPerShare", "dividends_per_share"), ("dividendPayoutRatioFy", "dividend_payout"),
    ("fiveYearAnnualDividendGrowthRate", "dividend_growth_5y"),
    ("marketCapitalization", "market_cap"), ("sharesOutstanding", "shares_outstanding"),
    ("freeFloat", "free_float"), ("beta", "beta"),
    ("highPriceLast52Weeks", "high_52w"), ("lowPriceLast52Weeks", "low_52w"),
    ("averageDailyVolumeLast10Days", "avg_volume_10d"),
]


def _num(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f == 0 and v in (0, "0") else round(f, 4)


def metrics_row(share, fund):
    """One metrics row from a Share (instrument) and its fundamentals record."""
    row = {"ticker": share.get("ticker"), "name": share.get("name"), "sector": share.get("sector"),
           "asset_uid": share.get("assetUid"), "uid": share.get("uid"), "lot": share.get("lot"),
           "currency": (fund or {}).get("currency") or share.get("currency"),
           "period_end": str((fund or {}).get("fiscalPeriodEndDate") or "")[:10] or None}
    for api_key, col in MAP:
        row[col] = _num((fund or {}).get(api_key))
    row["source"] = "T-Invest GetAssetFundamentals"
    return row


def pick_shares(api, tickers=None, all_shares=False, class_code="TQBR", sector=None, country="RU"):
    """Shares to work on: the tickers given (looked up one by one), or the whole base list filtered."""
    if tickers:
        out = []
        for t in tickers:
            inst = api.instrument(t, class_code)
            if not inst.get("uid"):
                raise api_error("no instrument %s on %s" % (t.upper(), class_code))
            out.append(inst)
        return out
    rows = api.shares()
    out = []
    for s in rows:
        if class_code and s.get("classCode") != class_code:
            continue
        if country and str(s.get("countryOfRisk", "")).upper() != country:
            continue
        if not s.get("apiTradeAvailableFlag", True):
            continue
        if sector and str(s.get("sector", "")).lower() != sector.lower():
            continue
        out.append(s)
    return sorted(out, key=lambda s: s.get("ticker", ""))


class api_error(Exception):
    pass


def merge_metrics(path, rows, as_of):
    existing = {}
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            try:
                existing = {r["ticker"]: r for r in json.load(fh).get("companies", []) if r.get("ticker")}
            except (ValueError, AttributeError):
                existing = {}
    for r in rows:
        existing[r["ticker"]] = r
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    doc = {"as_of": as_of, "source": "T-Invest GetAssetFundamentals",
           "companies": sorted(existing.values(), key=lambda r: r["ticker"])}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return doc


def _fmt(v, kind="n"):
    if v is None:
        return "-"
    if kind == "big":
        a = abs(v)
        if a >= 1e12:
            return "%.2f трлн" % (v / 1e12)
        if a >= 1e9:
            return "%.1f млрд" % (v / 1e9)
        if a >= 1e6:
            return "%.0f млн" % (v / 1e6)
        return "%.0f" % v
    return ("%.1f" % v) if abs(v) < 1000 else "%.0f" % v


def table(rows):
    head = "%-7s %-22s %10s %9s %6s %6s %7s %6s %7s %8s %8s" % (
        "тикер", "компания", "выручка", "прибыль", "P/E", "P/B", "EV/EBT", "ROE", "див.%", "долг/EBT", "рост выр.")
    lines = [head]
    for r in rows:
        lines.append("%-7s %-22s %10s %9s %6s %6s %7s %6s %7s %8s %8s" % (
            r["ticker"], (r.get("name") or "")[:22], _fmt(r.get("revenue_ttm"), "big"), _fmt(r.get("net_income_ttm"), "big"),
            _fmt(r.get("pe")), _fmt(r.get("pb")), _fmt(r.get("ev_ebitda")), _fmt(r.get("roe")),
            _fmt(r.get("dividend_yield")), _fmt(r.get("net_debt_to_ebitda")), _fmt(r.get("revenue_growth_yoy"))))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="MOEX fundamentals from T-Invest API -> trader/metrics.json")
    ap.add_argument("tickers", nargs="*")
    ap.add_argument("--all", action="store_true", help="every RU share on the board (hundreds of rows)")
    ap.add_argument("--sector", help="with --all: only this sector (as the API names it, e.g. energy, financial)")
    ap.add_argument("--class-code", default=None)
    ap.add_argument("--metrics", default="trader/metrics.json")
    ap.add_argument("--no-write", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--raw", action="store_true", help="print the API records as they come")
    ap.add_argument("--dividends", action="store_true", help="also list dividends of the last 2 years")
    ap.add_argument("--config", default="trader/config.json")
    ap.add_argument("--env", choices=["sandbox", "prod"])
    ap.add_argument("--token-file")
    a = ap.parse_args(argv)
    tv = load_tinvest()
    if not a.tickers and not a.all:
        ap.error("give tickers, or --all")
    try:
        cfg = tv.read_json(a.config, "config", required=False) or {}
        env = tv.env_from(cfg, a.env)
        api = tv.Api(env, tv.token_for(env, a.token_file))
        class_code = a.class_code or cfg.get("class_code") or tv.DEFAULT_CLASS
        shares = pick_shares(api, [t.upper() for t in a.tickers], a.all, class_code, a.sector)
        if not shares:
            raise api_error("no shares matched")
        by_asset = {s.get("assetUid"): s for s in shares if s.get("assetUid")}
        funds = {f.get("assetUid"): f for f in api.fundamentals(by_asset.keys())}
        if a.raw:
            print(json.dumps([funds.get(u) for u in by_asset], indent=2, ensure_ascii=False))
            return 0
        rows = [metrics_row(s, funds.get(u)) for u, s in by_asset.items()]
        missing = [s["ticker"] for s in shares if not s.get("assetUid") or not funds.get(s.get("assetUid"))]
        as_of = datetime.date.today().isoformat()
        if a.json:
            print(json.dumps({"as_of": as_of, "companies": rows, "missing": missing}, indent=2, ensure_ascii=False))
        else:
            print(table(rows))
            if missing:
                print("no fundamentals for: %s" % ", ".join(missing))
        if a.dividends:
            end = datetime.datetime.now(datetime.timezone.utc)
            start = end - datetime.timedelta(days=730)
            iso = lambda d: d.replace(microsecond=0).isoformat().replace("+00:00", "Z")
            for s in shares:
                divs = api.dividends(s["uid"], iso(start), iso(end))
                print("%s dividends (2 years): %s" % (s["ticker"], ", ".join(
                    "%s %s on %s" % (tv.q2f(d.get("dividendNet")), (d.get("dividendNet") or {}).get("currency", ""),
                                     str(d.get("recordDate", ""))[:10]) for d in divs) or "none"))
        if not a.no_write:
            merge_metrics(a.metrics, rows, as_of)
            if not a.json:
                print("wrote %d row(s) to %s" % (len(rows), a.metrics))
    except (tv.TinvestError, api_error) as exc:
        print("moex_facts.py: %s" % exc, file=sys.stderr)
        return 1
    print("Data as published by the broker. Education and tooling, not financial advice." if not a.json else "", end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
