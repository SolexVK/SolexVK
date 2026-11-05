#!/usr/bin/env python3
"""Copy a Moscow Exchange index (trader-copycat, MOEX edition). Standard library only, no keys.

Reads an index's composition and weights from the exchange's open data (ISS)
and writes trader/targets.json so trader-budget can size it to your money.

    python3 moex_index.py list                          # IMOEX: every constituent and its weight
    python3 moex_index.py list --index MOEXBC           # the blue-chip index
    python3 moex_index.py copy --top 10                 # top 10 by weight, renormalised to 100 -> trader/targets.json
    python3 moex_index.py copy --min-weight 2 --exclude GAZP
    python3 moex_index.py indexes                       # a few indexes you can copy

Source: https://iss.moex.com/iss/statistics/engines/stock/markets/index/analytics/<INDEX>.json
Offline: --offline DIR reads <INDEX>.json from DIR (the tests use it).
An index is a list, not advice: it holds what the exchange's committee put in it.
"""

import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
try:
    from common.net import open_url, NetError, MOEX_HOSTS  # noqa: E402
except ImportError:  # pragma: no cover
    raise SystemExit("moex_index.py: common/net.py not found; keep this script inside the trader-skill folder")

ISS = "https://iss.moex.com/iss/statistics/engines/stock/markets/index/analytics/%s.json?limit=100&start=%d"
UA = "trader-skill/1.0 (+https://github.com/SolexVK/SolexVK)"
KNOWN = {
    "IMOEX": "Индекс Мосбиржи: около 40-50 самых ликвидных акций",
    "MOEXBC": "Индекс голубых фишек: 15 крупнейших",
    "MOEXBMI": "Индекс широкого рынка: около 100 бумаг",
    "MOEX10": "Индекс Мосбиржи 10: 10 самых ликвидных",
    "MOEXOG": "Нефть и газ", "MOEXFN": "Финансы", "MOEXMM": "Металлы и добыча",
    "MOEXCN": "Потребительский сектор", "MOEXTL": "Телекоммуникации", "MOEXEU": "Электроэнергетика",
    "MOEXIT": "Информационные технологии", "MOEXCH": "Химия и нефтехимия", "MOEXTN": "Транспорт",
}


class IndexError_(Exception):
    pass


def fetch_page(index, start, offline=None):
    if offline:
        path = os.path.join(offline, "%s.json" % index)
        if not os.path.isfile(path):
            raise IndexError_("offline: no file %s" % path)
        with open(path, encoding="utf-8") as fh:
            return json.load(fh) if start == 0 else {"analytics": {"columns": [], "data": []}}
    url = ISS % (urllib.parse.quote(index), start)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with open_url(req, timeout=30, allowed=MOEX_HOSTS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except NetError as exc:
        raise IndexError_(str(exc))
    except urllib.error.HTTPError as exc:
        raise IndexError_("HTTP %s for %s" % (exc.code, url))
    except urllib.error.URLError as exc:
        raise IndexError_("could not reach iss.moex.com: %s" % exc.reason)
    except ValueError as exc:
        raise IndexError_("ISS did not return JSON: %s" % exc)


def composition(index, offline=None):
    """[{ticker, name, weight, date}] for the index, every page."""
    rows, start = [], 0
    while True:
        doc = fetch_page(index, start, offline)
        block = doc.get("analytics") or {}
        cols = block.get("columns") or []
        data = block.get("data") or []
        if not data:
            break
        idx = {c: i for i, c in enumerate(cols)}
        for r in data:
            ticker = r[idx["ticker"]] if "ticker" in idx else r[idx.get("secids", 0)]
            rows.append({"ticker": str(ticker).upper(), "name": r[idx["shortnames"]] if "shortnames" in idx else "",
                         "weight": float(r[idx["weight"]] or 0), "date": r[idx["tradedate"]] if "tradedate" in idx else None})
        if len(data) < 100:
            break
        start += 100
    if not rows:
        raise IndexError_("ISS knows no composition for %r (try: indexes)" % index)
    return sorted(rows, key=lambda x: -x["weight"])


def copy_weights(rows, top=None, min_weight=None, exclude=()):
    """Keep the top N / the ones over min_weight / not excluded; renormalise to 100."""
    ex = {t.upper() for t in exclude}
    keep = [r for r in rows if r["ticker"] not in ex and (min_weight is None or r["weight"] >= min_weight)]
    if top:
        keep = keep[:top]
    total = sum(r["weight"] for r in keep)
    if not keep or total <= 0:
        raise IndexError_("nothing left to copy after the filters")
    out = []
    for r in keep:
        out.append({"ticker": r["ticker"], "name": r["name"], "weight": round(100.0 * r["weight"] / total, 2),
                    "index_weight": r["weight"]})
    drift = round(100.0 - sum(x["weight"] for x in out), 2)
    if drift:
        out[0]["weight"] = round(out[0]["weight"] + drift, 2)
    return out


def write_targets(path, index, rows, weights, method):
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    doc = {"source": "MOEX ISS index %s, composition as of %s" % (index, rows[0].get("date") or "?"),
           "as_of": rows[0].get("date"), "index": index, "method": method,
           "fetched": datetime.date.today().isoformat(), "weights": weights,
           "why": "Копия индекса %s: %s. Веса биржи перенормированы на 100%%." % (index, KNOWN.get(index, "индекс Мосбиржи"))}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser(description="Copy a Moscow Exchange index into trader/targets.json")
    sub = ap.add_subparsers(dest="cmd")

    def common(p):
        p.add_argument("--index", default="IMOEX")
        p.add_argument("--offline", metavar="DIR")
        p.add_argument("--json", action="store_true")
    p = sub.add_parser("list", help="composition and weights"); common(p)
    p = sub.add_parser("copy", help="write trader/targets.json"); common(p)
    p.add_argument("--top", type=int)
    p.add_argument("--min-weight", type=float)
    p.add_argument("--exclude", nargs="*", default=[])
    p.add_argument("--out", default="trader/targets.json")
    sub.add_parser("indexes", help="indexes you can copy")
    a = ap.parse_args(argv)
    if not a.cmd:
        ap.print_help()
        return 1
    if a.cmd == "indexes":
        for k, v in KNOWN.items():
            print("%-8s %s" % (k, v))
        return 0
    try:
        rows = composition(a.index.upper(), a.offline)
        if a.cmd == "list":
            if a.json:
                print(json.dumps(rows, indent=2, ensure_ascii=False))
            else:
                print("%s, composition as of %s, %d constituents" % (a.index.upper(), rows[0].get("date"), len(rows)))
                for r in rows:
                    print("  %-7s %6.2f%%  %s" % (r["ticker"], r["weight"], r["name"]))
            return 0
        weights = copy_weights(rows, a.top, a.min_weight, a.exclude)
        method = "top %s by weight" % a.top if a.top else ("weight >= %s" % a.min_weight if a.min_weight else "all")
        if a.exclude:
            method += ", excluding " + ", ".join(t.upper() for t in a.exclude)
        doc = write_targets(a.out, a.index.upper(), rows, weights, method)
        if a.json:
            print(json.dumps(doc, indent=2, ensure_ascii=False))
        else:
            print("%s -> %s (%s):" % (a.index.upper(), a.out, method))
            for w in weights:
                print("  %-7s %6.2f%%  (in the index %5.2f%%)  %s" % (w["ticker"], w["weight"], w["index_weight"], w["name"]))
            print("Next: trader-budget sizes it (/propose), trader-risk checks, trader-broker asks you yes or no. "
                  "An index is a list, not advice.")
    except IndexError_ as exc:
        print("moex_index.py: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
