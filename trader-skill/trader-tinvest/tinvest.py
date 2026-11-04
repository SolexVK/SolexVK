#!/usr/bin/env python3
"""T-Invest (Т-Банк) adapter for the trader pack. Standard library only.

Talks to T-Invest API over its REST gateway (JSON over HTTPS), the same methods
as gRPC. Two environments, two tokens, never mixed:

  sandbox   https://sandbox-invest-public-api.tbank.ru/rest   TINVEST_SANDBOX_TOKEN
  prod      https://invest-public-api.tbank.ru/rest           TINVEST_TOKEN

The environment comes from trader/config.json: "paper": true means sandbox.
Tokens come from environment variables (or --token-file) and are never printed,
logged or written anywhere.

    python3 tinvest.py whoami                      # environment, accounts, access level
    python3 tinvest.py sandbox open --name robot   # open a sandbox account
    python3 tinvest.py sandbox payin 100000        # top it up (RUB)
    python3 tinvest.py find сбер                   # search instruments
    python3 tinvest.py quote SBER GAZP --write     # last prices -> trader/prices.json
    python3 tinvest.py portfolio --write           # positions, cash -> trader/portfolio.json
    python3 tinvest.py order --index 1 [--dry-run] # place ONE approved order
    python3 tinvest.py orders                      # active orders
    python3 tinvest.py order-state --id <orderId>
    python3 tinvest.py schedule --write            # trading days and hours -> trader/state/schedule.json

`order` is the only command that can move money. It refuses unless, for that
exact order (matched by fingerprint): trader-risk passed it today, ticket.py
recorded your explicit yes today, and no result was recorded yet. A live
order additionally needs "paper": false in the config AND TINVEST_LIVE=yes in
the environment, and the account must answer as an open full-access account.

Not financial advice. Education and tooling.
"""

import argparse
import datetime
import importlib.util
import json
import math
import os
import sys
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
try:
    from common.net import open_url, NetError, TINVEST_HOSTS  # noqa: E402
except ImportError:  # pragma: no cover
    raise SystemExit("tinvest.py: common/net.py not found; keep this script inside the trader-skill folder")

BASE = {"sandbox": "https://sandbox-invest-public-api.tbank.ru/rest",
        "prod": "https://invest-public-api.tbank.ru/rest"}
TOKEN_VAR = {"sandbox": "TINVEST_SANDBOX_TOKEN", "prod": "TINVEST_TOKEN"}
V1 = "tinkoff.public.invest.api.contract.v1."
# the same call, per environment
METHODS = {
    "accounts": {"sandbox": "SandboxService/GetSandboxAccounts", "prod": "UsersService/GetAccounts"},
    "portfolio": {"sandbox": "SandboxService/GetSandboxPortfolio", "prod": "OperationsService/GetPortfolio"},
    "post_order": {"sandbox": "SandboxService/PostSandboxOrder", "prod": "OrdersService/PostOrder"},
    "orders": {"sandbox": "SandboxService/GetSandboxOrders", "prod": "OrdersService/GetOrders"},
    "order_state": {"sandbox": "SandboxService/GetSandboxOrderState", "prod": "OrdersService/GetOrderState"},
}
DEFAULT_CLASS = "TQBR"       # MOEX main board for shares and ETFs
CASH_TICKER = "RUB000UTSTOM"  # the rouble "instrument" in a portfolio
UA = "trader-skill-tinvest/1.0 (+https://github.com/SolexVK/SolexVK)"


class TinvestError(Exception):
    pass


# ---------------------------------------------------------------- money

def q2f(q):
    """Quotation / MoneyValue -> float. units is a string in JSON, nano an int."""
    if not q:
        return 0.0
    return int(q.get("units") or 0) + int(q.get("nano") or 0) / 1e9


def f2q(x, currency=None):
    """float -> Quotation (or MoneyValue when currency is given)."""
    x = float(x)
    units = int(math.floor(abs(x)))
    nano = int(round((abs(x) - units) * 1e9))
    if nano >= 1000000000:
        units, nano = units + 1, nano - 1000000000
    if x < 0:
        units, nano = -units, -nano
    out = {"units": str(units), "nano": nano}
    if currency:
        out["currency"] = currency
    return out


def money(x, cur="RUB"):
    s = "{:,.2f}".format(float(x))
    s = s[:-3] if s.endswith(".00") else s
    return "$" + s if cur == "USD" else "%s %s" % (s, cur)


# ---------------------------------------------------------------- transport

def token_for(env, token_file=None):
    """The token for this environment. Never returned to the user, never printed."""
    if token_file:
        with open(token_file, encoding="utf-8") as fh:
            tok = fh.read().strip()
    else:
        tok = os.environ.get(TOKEN_VAR[env], "").strip()
    if not tok:
        raise TinvestError("no token for %s: set %s (or --token-file). Never paste a token in the chat."
                           % (env, TOKEN_VAR[env]))
    return tok


def call(env, method, body, token, timeout=30):
    """POST one API method. Replaced by a fake in the tests."""
    url = "%s/%s%s" % (BASE[env], V1, method)
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json",
        "Accept": "application/json", "User-Agent": UA, "x-app-name": "SolexVK.trader-skill"})
    try:
        with open_url(req, timeout=timeout, allowed=TINVEST_HOSTS) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except NetError as exc:
        raise TinvestError(str(exc))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            err = json.loads(raw)
            msg = "%s (code %s)" % (err.get("message") or raw, err.get("code"))
        except ValueError:
            msg = raw[:300]
        if exc.code == 401 or "40003" in msg:
            msg += ". The token is missing, expired (3 months unused) or for the other environment."
        raise TinvestError("%s: HTTP %d %s" % (method, exc.code, msg))
    except urllib.error.URLError as exc:
        raise TinvestError("could not reach %s: %s" % (BASE[env], exc.reason))


class Api(object):
    def __init__(self, env, token):
        if env not in BASE:
            raise TinvestError("environment must be sandbox or prod, got %r" % env)
        self.env, self.token = env, token

    def _m(self, key):
        return METHODS[key][self.env]

    def accounts(self):
        return call(self.env, self._m("accounts"), {}, self.token).get("accounts", [])

    def portfolio(self, account_id, currency="RUB"):
        return call(self.env, self._m("portfolio"),
                    {"accountId": account_id, "currency": currency}, self.token)

    def instrument(self, ticker, class_code=DEFAULT_CLASS):
        body = {"idType": "INSTRUMENT_ID_TYPE_TICKER", "classCode": class_code, "id": ticker.upper()}
        return call(self.env, "InstrumentsService/GetInstrumentBy", body, self.token).get("instrument") or {}

    def instrument_by_uid(self, uid):
        body = {"idType": "INSTRUMENT_ID_TYPE_UID", "id": uid}
        return call(self.env, "InstrumentsService/GetInstrumentBy", body, self.token).get("instrument") or {}

    def find(self, query):
        body = {"query": query, "apiTradeAvailableFlag": True}
        return call(self.env, "InstrumentsService/FindInstrument", body, self.token).get("instruments", [])

    def last_prices(self, ids):
        return call(self.env, "MarketDataService/GetLastPrices", {"instrumentId": list(ids)},
                    self.token).get("lastPrices", [])

    def post_order(self, body):
        return call(self.env, self._m("post_order"), body, self.token)

    def orders(self, account_id):
        return call(self.env, self._m("orders"), {"accountId": account_id}, self.token).get("orders", [])

    def order_state(self, account_id, order_id):
        return call(self.env, self._m("order_state"), {"accountId": account_id, "orderId": order_id}, self.token)

    def schedules(self, exchange, start, end):
        body = {"exchange": exchange, "from": start, "to": end}
        return call(self.env, "InstrumentsService/TradingSchedules", body, self.token).get("exchanges", [])

    def sandbox_open(self, name=None):
        if self.env != "sandbox":
            raise TinvestError("sandbox accounts are opened in the sandbox only")
        body = {"name": name} if name else {}
        return call(self.env, "SandboxService/OpenSandboxAccount", body, self.token)

    def sandbox_payin(self, account_id, amount, currency="RUB"):
        if self.env != "sandbox":
            raise TinvestError("pay-in is a sandbox method; a real account is funded in the T-Bank app")
        body = {"accountId": account_id, "amount": f2q(amount, currency)}
        return call(self.env, "SandboxService/SandboxPayIn", body, self.token)


# ---------------------------------------------------------------- files

def read_json(path, what, required=True):
    if not path or not os.path.exists(path):
        if required:
            raise TinvestError("no %s at %s" % (what, path))
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except json.JSONDecodeError as e:
        raise TinvestError("%s is not valid JSON: %s" % (path, e))


def write_json(path, data):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


def load_ticket():
    """trader-broker/ticket.py: the fingerprint, the decision log and the fill bookkeeping.
    Loaded from the sibling folder so there is exactly one definition of each."""
    path = os.path.join(HERE, "..", "trader-broker", "ticket.py")
    if not os.path.isfile(path):
        raise TinvestError("trader-broker/ticket.py not found next to this skill")
    spec = importlib.util.spec_from_file_location("trader_ticket", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def now_iso():
    return datetime.datetime.now().replace(microsecond=0).isoformat()


# ---------------------------------------------------------------- environment

def env_from(cfg, override=None, for_order=False):
    """sandbox when "paper" is true (the default). `order` never takes an override."""
    paper = cfg.get("paper", True)
    env = "sandbox" if paper else "prod"
    if override and override != env:
        if for_order:
            raise TinvestError("order follows trader/config.json (\"paper\": %s means %s); --env cannot override it"
                               % (json.dumps(paper), env))
        env = override
    return env


def live_guard(env):
    if env == "prod" and os.environ.get("TINVEST_LIVE", "").strip().lower() not in ("yes", "1", "true"):
        raise TinvestError("this is the LIVE environment. To allow a real order set TINVEST_LIVE=yes "
                           "for this one run (and keep \"paper\": false in trader/config.json on purpose).")


def pick_account(api, cfg):
    """The account from the config, verified against what the API answers."""
    want = str(cfg.get("account_id") or "").strip()
    accounts = api.accounts()
    if not accounts:
        raise TinvestError("the API lists no accounts in %s%s" % (
            api.env, " (open one: tinvest.py sandbox open)" if api.env == "sandbox" else ""))
    if not want:
        if len(accounts) == 1:
            acc = accounts[0]
        else:
            raise TinvestError("several accounts; put the one to use in trader/config.json as \"account_id\": %s"
                               % ", ".join(a.get("id", "?") for a in accounts))
    else:
        match = [a for a in accounts if a.get("id") == want]
        if not match:
            raise TinvestError("account %s is not among the %s accounts this token can see" % (want, api.env))
        acc = match[0]
    return acc


def account_ok_for_orders(acc):
    if acc.get("status", "ACCOUNT_STATUS_OPEN") not in ("ACCOUNT_STATUS_OPEN", "ACCOUNT_STATUS_UNSPECIFIED"):
        raise TinvestError("account %s is %s, not open" % (acc.get("id"), acc.get("status")))
    level = acc.get("accessLevel", "ACCOUNT_ACCESS_LEVEL_FULL_ACCESS")
    if level != "ACCOUNT_ACCESS_LEVEL_FULL_ACCESS":
        raise TinvestError("account %s: this token has %s; orders need a full-access token"
                           % (acc.get("id"), level))
    if acc.get("type") == "ACCOUNT_TYPE_INVEST_BOX":
        raise TinvestError("account %s is an Invest Box; orders are not allowed on it" % acc.get("id"))


# ---------------------------------------------------------------- lots

def lots_for(order, inst, price):
    """How many lots this order means. qty is in shares; notional in money."""
    lot = int(inst.get("lot") or 1)
    if order.get("qty") is not None:
        shares = float(order["qty"])
        lots = int(math.floor(shares / lot + 1e-9))
        why = "%s shares at lot size %d" % (_num(shares), lot)
    else:
        notional = float(order["notional"])
        if not price or price <= 0:
            raise TinvestError("no price for %s to turn %s into lots" % (inst.get("ticker"), money(notional)))
        lots = int(math.floor(notional / (price * lot) + 1e-9))
        why = "%s at %s per share, lot size %d" % (money(notional), money(price), lot)
    if lots < 1:
        raise TinvestError("%s is less than one lot (%s); raise the amount or pick a smaller lot"
                           % (why, "%d x %s = %s" % (lot, money(price), money(lot * price)) if price else "lot %d" % lot))
    return lots, lot


def _num(x):
    x = float(x)
    return str(int(x)) if x == int(x) else ("%.4f" % x).rstrip("0")


def order_body(order, inst, account_id, lots, idem):
    typ = str(order.get("type", "market")).lower()
    tif = str(order.get("time_in_force", "day")).lower()
    if typ not in ("market", "limit"):
        raise TinvestError("T-Invest adapter places market and limit orders only, not %s" % typ)
    if tif != "day":
        raise TinvestError("T-Invest adapter places day orders only, not %s" % tif)
    body = {"accountId": account_id, "instrumentId": inst["uid"], "quantity": str(lots),
            "direction": "ORDER_DIRECTION_BUY" if order["side"] == "buy" else "ORDER_DIRECTION_SELL",
            "orderType": "ORDER_TYPE_MARKET" if typ == "market" else "ORDER_TYPE_LIMIT",
            "orderId": idem}
    if typ == "limit":
        body["price"] = f2q(order["limit_price"])
        body["timeInForce"] = "TIME_IN_FORCE_DAY"
    return body


# ---------------------------------------------------------------- commands

def _api(a, cfg, for_order=False):
    env = env_from(cfg, a.env, for_order=for_order)
    return Api(env, token_for(env, a.token_file))


def cmd_whoami(a):
    cfg = read_json(a.config, "config", required=False) or {}
    api = _api(a, cfg)
    print("Environment: %s (%s)" % (api.env, BASE[api.env]))
    accounts = api.accounts()
    if not accounts:
        print("No accounts visible to this token." + (" Open one: tinvest.py sandbox open" if api.env == "sandbox" else ""))
        return 1
    for acc in accounts:
        print("  %s  %s  %s  %s  %s" % (acc.get("id"), acc.get("type", "").replace("ACCOUNT_TYPE_", ""),
                                        acc.get("status", "").replace("ACCOUNT_STATUS_", ""),
                                        acc.get("accessLevel", "").replace("ACCOUNT_ACCESS_LEVEL_", ""),
                                        acc.get("name", "")))
    want = cfg.get("account_id")
    if want:
        print("config account_id: %s (%s)" % (want, "found" if any(x.get("id") == want for x in accounts) else "NOT FOUND"))
    else:
        print("Put the account to use in trader/config.json as \"account_id\".")
    return 0


def cmd_sandbox(a):
    cfg = read_json(a.config, "config", required=False) or {}
    api = _api(a, cfg)
    if api.env != "sandbox":
        raise TinvestError("sandbox commands run in the sandbox; your config says \"paper\": false")
    if a.action == "open":
        r = api.sandbox_open(a.name)
        print("Opened sandbox account %s. Put it in trader/config.json as \"account_id\"." % r.get("accountId"))
        return 0
    acc = pick_account(api, cfg)
    r = api.sandbox_payin(acc["id"], a.amount, a.currency)
    print("Paid %s into sandbox account %s. Balance now %s." % (money(a.amount, a.currency), acc["id"],
                                                             money(q2f(r.get("balance")), a.currency)))
    return 0


def cmd_find(a):
    cfg = read_json(a.config, "config", required=False) or {}
    api = _api(a, cfg)
    rows = api.find(a.query)
    if not rows:
        print("Nothing found for %r." % a.query)
        return 1
    for r in rows[:a.limit]:
        print("%-8s %-6s %-5s lot %-5s %s  uid %s%s" % (
            r.get("ticker"), r.get("classCode"), r.get("instrumentType", "")[:5], r.get("lot"), r.get("name"),
            r.get("uid"), "  QUAL ONLY" if r.get("forQualInvestorFlag") else ""))
    return 0


def resolve(api, tickers, class_code):
    out = {}
    for t in tickers:
        inst = api.instrument(t, class_code)
        if not inst.get("uid"):
            raise TinvestError("no instrument %s on %s" % (t.upper(), class_code))
        out[t.upper()] = inst
    return out


def cmd_quote(a):
    cfg = read_json(a.config, "config", required=False) or {}
    api = _api(a, cfg)
    class_code = a.class_code or cfg.get("class_code") or DEFAULT_CLASS
    tickers = [t.upper() for t in a.tickers]
    if not tickers:
        pf = read_json(a.prices_portfolio, "portfolio", required=False) or {}
        tickers = [str(p.get("ticker", "")).upper() for p in pf.get("positions", []) if p.get("ticker")]
        if not tickers:
            raise TinvestError("give tickers, or have positions in %s" % a.prices_portfolio)
    insts = resolve(api, tickers, class_code)
    by_uid = {i["uid"]: t for t, i in insts.items()}
    prices, detail = {}, {}
    for lp in api.last_prices(by_uid.keys()):
        t = by_uid.get(lp.get("instrumentUid"))
        if not t:
            continue
        prices[t] = round(q2f(lp.get("price")), 6)
        detail[t] = {"lot": insts[t].get("lot"), "currency": insts[t].get("currency"), "time": lp.get("time"),
                     "uid": insts[t].get("uid"), "class_code": insts[t].get("classCode"),
                     "api_trade": bool(insts[t].get("apiTradeAvailableFlag", True)),
                     "qual_only": bool(insts[t].get("forQualInvestorFlag", False)),
                     "name": insts[t].get("name")}
    missing = [t for t in tickers if t not in prices]
    for t in tickers:
        if t in prices:
            flags = ("" if detail[t]["api_trade"] else "  NOT TRADABLE VIA API") + ("  QUAL ONLY" if detail[t]["qual_only"] else "")
            print("%-8s %12s  lot %s%s" % (t, money(prices[t], detail[t]["currency"] or "RUB"), detail[t]["lot"], flags))
    if missing:
        print("no price for: %s" % ", ".join(missing))
    if a.write:
        doc = read_json(a.out, "prices", required=False) or {}
        doc.setdefault("prices", {}).update(prices)
        doc.setdefault("detail", {}).update(detail)
        doc["as_of"] = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        doc["source"] = "tinvest-%s" % api.env
        doc["note"] = "last trade prices from T-Invest API (%s)" % api.env
        write_json(a.out, doc)
        print("wrote %s" % a.out)
    return 0 if not missing else 1


def cmd_portfolio(a):
    cfg = read_json(a.config, "config", required=False) or {}
    api = _api(a, cfg)
    acc = pick_account(api, cfg)
    cur = cfg.get("currency", "RUB")
    pf = api.portfolio(acc["id"], cur)
    cash = None
    rows = []
    for p in pf.get("positions", []):
        kind = p.get("instrumentType", "")
        ticker = p.get("ticker")
        if not ticker:
            ticker = api.instrument_by_uid(p.get("instrumentUid", "")).get("ticker", p.get("figi"))
        qty = q2f(p.get("quantity"))
        if kind == "currency":
            if ticker == CASH_TICKER:
                cash = qty
            continue
        if kind not in ("share", "etf"):
            print("  (skipping %s %s: this pack tracks shares and ETFs only)" % (kind, ticker))
            continue
        rows.append({"ticker": ticker, "shares": qty, "avg": q2f(p.get("averagePositionPrice")),
                     "price": q2f(p.get("currentPrice")), "kind": kind})
    if cash is None:
        cash = q2f(pf.get("totalAmountCurrencies"))
    total = q2f(pf.get("totalAmountPortfolio"))
    print("Account %s (%s): total %s, cash %s" % (acc["id"], api.env, money(total, cur), money(cash, cur)))
    for r in rows:
        print("  %-8s %10s  avg %10s  now %10s  value %s" % (r["ticker"], _num(r["shares"]), money(r["avg"], cur),
                                                           money(r["price"], cur), money(r["shares"] * r["price"], cur)))
    if a.write:
        old = read_json(a.out, "portfolio", required=False) or {}
        old_pos = {str(p.get("ticker", "")).upper(): p for p in old.get("positions", [])}
        today = datetime.date.today().isoformat()
        positions = []
        for r in rows:
            prev = old_pos.get(r["ticker"].upper())
            if prev and abs(float(prev.get("shares", 0)) - r["shares"]) < 1e-9 and prev.get("lots"):
                positions.append(prev)  # keep the tax lots trader-broker recorded
            else:
                positions.append({"ticker": r["ticker"], "shares": r["shares"],
                                  "lots": [{"id": "%s-broker" % r["ticker"], "date": today, "shares": r["shares"],
                                            "cost": round(r["shares"] * r["avg"], 2)}]})
        write_json(a.out, {"cash": round(cash, 2), "positions": positions, "source": "tinvest-%s" % api.env,
                           "account_id": acc["id"], "as_of": now_iso()})
        print("wrote %s" % a.out)
    return 0


def cmd_order(a):
    ticket = load_ticket()
    doc = read_json(a.orders, "orders file (run trader-budget, trader-rebalance or trader-tax first)")
    orders = doc.get("orders", doc) if isinstance(doc, dict) else doc
    if not isinstance(orders, list) or not 1 <= a.index <= len(orders):
        raise TinvestError("there is no order %d in %s" % (a.index, a.orders))
    order = orders[a.index - 1]
    cfg = read_json(a.config, "config", required=False) or {}
    if str(cfg.get("broker", "")).lower() != "tinvest":
        raise TinvestError("trader/config.json must say \"broker\": \"tinvest\" for this adapter to place anything")
    today = a.today or datetime.date.today().isoformat()
    fp = ticket.fingerprint(order)

    # gate 1: trader-risk passed this exact order today
    risk = read_json(a.risk, "risk check", required=False)
    rv, why = ticket.risk_verdict(risk, fp, today)
    if rv is None:
        raise TinvestError("not placing: " + why)
    if rv.get("verdict") != "PASS":
        raise TinvestError("not placing: trader-risk BLOCKED this order: " + "; ".join(rv.get("reasons", [])))
    # gate 2: your yes for this exact order today, and nothing decided after it
    state = ticket.load_state(a.state)
    rec = ticket.latest(state, fp, today)
    if not rec or rec.get("status") != "approved":
        raise TinvestError("not placing: no yes recorded today for order %d (ticket.py approve --index %d --reply ...)"
                           % (a.index, a.index) if not rec else
                           "not placing: order %d already has a result today: %s" % (a.index, rec.get("status")))
    # gate 3: environment and token match the config; live needs an explicit opt-in
    api = _api(a, cfg, for_order=True)
    live_guard(api.env)
    acc = pick_account(api, cfg)
    account_ok_for_orders(acc)

    def failed(exc):
        """Your yes was recorded, then something refused: write it down so the ticket is not stuck."""
        if not a.dry_run:
            state["orders"].append({"at": now_iso(), "date": today, "index": a.index, "fingerprint": fp,
                                    "symbol": rec["symbol"], "side": rec["side"], "plain": rec["plain"],
                                    "status": "failed", "note": str(exc)[:300], "env": api.env})
            ticket.write_json(a.state, state)

    class_code = cfg.get("class_code") or DEFAULT_CLASS
    try:
        inst = api.instrument(order["symbol"], class_code)
        if not inst.get("uid"):
            raise TinvestError("no instrument %s on %s" % (order["symbol"], class_code))
        if not inst.get("apiTradeAvailableFlag", True):
            raise TinvestError("%s cannot be traded through the API" % order["symbol"])
        if inst.get("forQualInvestorFlag") and not cfg.get("allow_qual_only"):
            raise TinvestError("%s is for qualified investors only (\"allow_qual_only\": true to override)" % order["symbol"])
        price = None
        if order.get("notional") is not None or a.dry_run:
            lps = api.last_prices([inst["uid"]])
            price = q2f(lps[0].get("price")) if lps else None
        lots, lot = lots_for(order, inst, price)
        idem = str(uuid.uuid5(uuid.NAMESPACE_URL, "trader-tinvest:%s:%s:%s:%d" % (acc["id"], fp, today, a.index)))
        body = order_body(order, inst, acc["id"], lots, idem)
    except TinvestError as exc:
        failed(exc)
        raise
    est = (price or float(order.get("limit_price") or 0)) * lots * lot
    print("%s %d lot%s of %s (%d share%s)%s, %s, %s account %s"
          % (order["side"].upper(), lots, "" if lots == 1 else "s", inst.get("ticker", order["symbol"]),
             lots * lot, "" if lots * lot == 1 else "s", (" ~ " + money(est)) if est else "",
             "market" if body["orderType"].endswith("MARKET") else "limit at " + money(order.get("limit_price")),
             api.env.upper(), acc["id"]))
    if a.dry_run:
        print("dry run, nothing sent. Request would be:")
        print(json.dumps(body, indent=2, ensure_ascii=False))
        return 0

    try:
        resp = api.post_order(body)
    except TinvestError as exc:
        failed(exc)
        raise
    executed = int(resp.get("lotsExecuted") or 0)
    exec_price = q2f(resp.get("executedOrderPrice"))
    fee = q2f(resp.get("executedCommission")) or q2f(resp.get("initialCommission"))
    new = {"at": now_iso(), "date": today, "index": a.index, "fingerprint": fp, "symbol": rec["symbol"],
           "side": rec["side"], "plain": rec["plain"], "status": "placed", "env": api.env,
           "broker_order_id": resp.get("orderId"), "report": resp.get("executionReportStatus"),
           "lots": lots, "lot_size": lot, "lots_executed": executed,
           "executed_price": exec_price or None, "fee": round(fee, 2), "idempotency_id": idem}
    state["orders"].append(new)
    ticket.write_json(a.state, state)
    print("Placed. Broker order id %s, status %s, executed %d of %d lots%s."
          % (resp.get("orderId"), (resp.get("executionReportStatus") or "").replace("EXECUTION_REPORT_STATUS_", ""),
             executed, lots, (" at " + money(exec_price)) if exec_price else ""))
    if executed and exec_price:
        ticket.apply_fill(a.portfolio, cfg, rec["symbol"], rec["side"], executed * lot, exec_price, today, fee)
        print("Recorded the fill (%d shares at %s%s) in %s." % (
            executed * lot, money(exec_price), (", commission " + money(fee)) if fee else "", a.portfolio))
    elif executed:
        print("Filled %d lots but no price in the answer; check: tinvest.py order-state --id %s" % (executed, resp.get("orderId")))
    else:
        print("Not filled yet; check later: tinvest.py order-state --id %s, then ticket.py fill ..." % resp.get("orderId"))
    return 0


def cmd_schedule(a):
    cfg = read_json(a.config, "config", required=False) or {}
    api = _api(a, cfg)
    exchange = a.exchange or cfg.get("exchange") or "MOEX"
    start = datetime.datetime.now(datetime.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + datetime.timedelta(days=a.days)
    iso = lambda d: d.isoformat().replace("+00:00", "Z")
    rows = api.schedules(exchange, iso(start), iso(end))
    if not rows:
        raise TinvestError("no schedule for exchange %r (try --exchange MOEX)" % exchange)
    days = {}
    for d in rows[0].get("days", []):
        date = str(d.get("date", ""))[:10]
        if not date:
            continue
        days[date] = {"trading": bool(d.get("isTradingDay")), "start": d.get("startTime"), "end": d.get("endTime"),
                      "evening_start": d.get("eveningStartTime"), "evening_end": d.get("eveningEndTime")}
    for date in sorted(days):
        x = days[date]
        print("%s  %s%s" % (date, "trading" if x["trading"] else "closed ",
                            ("  %s .. %s UTC" % (str(x["start"])[11:16], str(x["end"])[11:16])) if x["trading"] and x["start"] else ""))
    if a.write:
        write_json(a.out, {"exchange": rows[0].get("exchange", exchange), "fetched_at": now_iso(), "days": days})
        print("wrote %s" % a.out)
    return 0


def cmd_orders(a):
    cfg = read_json(a.config, "config", required=False) or {}
    api = _api(a, cfg)
    acc = pick_account(api, cfg)
    rows = api.orders(acc["id"])
    if not rows:
        print("No active orders on %s (%s)." % (acc["id"], api.env))
        return 0
    for o in rows:
        print("%s %s %s lots %s/%s %s %s" % (o.get("orderId"), o.get("direction", "").replace("ORDER_DIRECTION_", ""),
                                             o.get("figi") or o.get("instrumentUid"), o.get("lotsExecuted"),
                                             o.get("lotsRequested"), money(q2f(o.get("initialOrderPrice"))),
                                             o.get("executionReportStatus", "").replace("EXECUTION_REPORT_STATUS_", "")))
    return 0


def cmd_order_state(a):
    cfg = read_json(a.config, "config", required=False) or {}
    api = _api(a, cfg)
    acc = pick_account(api, cfg)
    o = api.order_state(acc["id"], a.id)
    print(json.dumps({k: o.get(k) for k in ("orderId", "executionReportStatus", "lotsRequested", "lotsExecuted",
                                             "executedOrderPrice", "totalOrderAmount", "direction", "orderType",
                                             "orderDate")}, indent=2, ensure_ascii=False))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="T-Invest (Т-Банк) adapter for the trader pack.")
    sub = ap.add_subparsers(dest="cmd")

    def common(p):
        p.add_argument("--config", default="trader/config.json")
        p.add_argument("--env", choices=["sandbox", "prod"], help="read-only commands may override the config")
        p.add_argument("--token-file", help="read the token from this file instead of the environment")

    p = sub.add_parser("whoami", help="environment, accounts, access level"); common(p)
    p = sub.add_parser("sandbox", help="open / payin"); common(p)
    p.add_argument("action", choices=["open", "payin"])
    p.add_argument("amount", nargs="?", type=float)
    p.add_argument("--name")
    p.add_argument("--currency", default="RUB")
    p = sub.add_parser("find", help="search instruments"); common(p)
    p.add_argument("query")
    p.add_argument("--limit", type=int, default=15)
    p = sub.add_parser("quote", help="last prices -> trader/prices.json"); common(p)
    p.add_argument("tickers", nargs="*")
    p.add_argument("--class-code")
    p.add_argument("--write", action="store_true")
    p.add_argument("--out", default="trader/prices.json")
    p.add_argument("--prices-portfolio", default="trader/portfolio.json", help="tickers to quote when none given")
    p = sub.add_parser("portfolio", help="positions and cash -> trader/portfolio.json"); common(p)
    p.add_argument("--write", action="store_true")
    p.add_argument("--out", default="trader/portfolio.json")
    p = sub.add_parser("order", help="place ONE approved order"); common(p)
    p.add_argument("--index", type=int, required=True)
    p.add_argument("--orders", default="trader/orders.json")
    p.add_argument("--risk", default="trader/state/risk.json")
    p.add_argument("--state", default="trader/state/broker.json")
    p.add_argument("--portfolio", default="trader/portfolio.json")
    p.add_argument("--today")
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("schedule", help="trading days and hours -> trader/state/schedule.json"); common(p)
    p.add_argument("--exchange", help="default: config \"exchange\" or MOEX")
    p.add_argument("--days", type=int, default=14)
    p.add_argument("--write", action="store_true")
    p.add_argument("--out", default="trader/state/schedule.json")
    p = sub.add_parser("orders", help="active orders"); common(p)
    p = sub.add_parser("order-state", help="one order by id"); common(p)
    p.add_argument("--id", required=True)
    a = ap.parse_args(argv)
    if not a.cmd:
        ap.print_help()
        return 1
    if a.cmd == "sandbox" and a.action == "payin" and a.amount is None:
        print("tinvest.py: sandbox payin needs an amount", file=sys.stderr)
        return 1
    try:
        return {"whoami": cmd_whoami, "sandbox": cmd_sandbox, "find": cmd_find, "quote": cmd_quote,
                "portfolio": cmd_portfolio, "order": cmd_order, "orders": cmd_orders,
                "order-state": cmd_order_state, "schedule": cmd_schedule}[a.cmd](a)
    except TinvestError as e:
        print("tinvest.py: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
