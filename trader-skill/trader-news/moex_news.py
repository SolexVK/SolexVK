#!/usr/bin/env python3
"""News monitor for Moscow Exchange stocks (trader-news, MOEX edition). Standard library only.

Reads Russian finance feeds, keeps the stories that name the stocks you hold
(or plan to copy), tags what the story is about, shows each story once, and
also surfaces market-wide items (key rate, the central bank, the index,
sanctions, dividends) unless --only-mine.

    python3 moex_news.py                          # tickers from trader/portfolio.json or targets.json
    python3 moex_news.py --tickers SBER LKOH GAZP
    python3 moex_news.py --all --hours 72         # everything in the last 3 days, seen or not
    python3 moex_news.py --only-mine              # only stories naming your tickers
    python3 moex_news.py --feeds finam moex       # a subset of the feeds

Feeds, one request each (not per ticker), no keys:
  finam      Финам, новости компаний            www.finam.ru/net/analysis/conews/rsspoint
  moex       уведомления Московской биржи        www.moex.com/export/news.aspx?cat=100
  interfax   Интерфакс, лента                    www.interfax.ru/rss.asp?r=1
  rbc        РБК, главное                        rssexport.rbc.ru/rbcnews/news/30/full.rss
  vedomosti  Ведомости, финансы                  www.vedomosti.ru/rss/rubric/finance

Names a headline uses for a ticker come from moex_aliases.json next to this
script (plus the instrument name from your portfolio). State lives in
trader/state/moex_news.json (30 days). Offline: --offline DIR reads <feed>.xml.
Headlines are leads, not facts: open the story before acting. Not advice.
"""

import argparse
import datetime as _dt
import html
import importlib.util
import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
try:
    from common.net import open_url, NetError, MOEX_HOSTS, RU_NEWS_HOSTS  # noqa: E402
except ImportError:  # pragma: no cover
    raise SystemExit("moex_news.py: common/net.py not found; keep this script inside the trader-skill folder")

FEEDS = {
    "finam": ("Финам", "https://www.finam.ru/net/analysis/conews/rsspoint"),
    "moex": ("Мосбиржа", "https://www.moex.com/export/news.aspx?cat=100"),
    "interfax": ("Интерфакс", "https://www.interfax.ru/rss.asp?r=1"),
    "rbc": ("РБК", "https://rssexport.rbc.ru/rbcnews/news/30/full.rss"),
    "vedomosti": ("Ведомости", "https://www.vedomosti.ru/rss/rubric/finance"),
}
DEFAULT_FEEDS = ["finam", "moex", "interfax", "rbc", "vedomosti"]
UA = "Mozilla/5.0 (compatible; trader-skill/1.0; +https://github.com/SolexVK/SolexVK)"
KEYWORDS = [
    ("отчётность", r"отчетност|отчётност|выручк|чистая прибыль|чистой прибыли|МСФО|РСБУ|EBITDA"),
    ("дивиденды", r"дивиденд|байбэк|обратн\w+ выкуп"),
    ("ставка", r"ключев\w+ ставк|ставк\w+ ЦБ|Банк России|Центробанк|ЦБ РФ|"
               r"(?<![\w-])ЦБ(?![\w-])(?!\s+(?:Узбекистан|Казахстан|Турци|Кита|Армени|Белорус|Кыргыз|Таджик|ЕС\b|Европ|Япони|Бразили|Инди))"),
    ("рынок", r"индекс Мосбирж|индекс МосБирж|IMOEX|рынок акций|российск\w+ рынок"),
    ("санкции", r"санкци|SDN|блокирующ"),
    ("сделка", r"поглощен|слияни|покупает|приобрет|продаёт долю|продает долю|сделк"),
    ("люди", r"гендиректор|генеральн\w+ директор|совет директоров|отставк|назначен"),
    ("риск", r"дефолт|банкрот|делистинг|приостанов\w+ торг|дестабилизаци|взлом|утечк"),
    ("нефть", r"нефт|Brent|Urals|ОПЕК"),
]
MARKET_TAGS = {"ставка", "рынок", "санкции"}
KEEP_DAYS = 30


class NewsError(Exception):
    pass


def load_news_module():
    """news.py next to this script: time parsing, dedupe, select, remember."""
    spec = importlib.util.spec_from_file_location("trader_news", os.path.join(HERE, "news.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------- feeds

def fetch(url, offline=None, name=None, timeout=30):
    if offline:
        path = os.path.join(offline, "%s.xml" % name)
        if not os.path.isfile(path):
            raise NewsError("offline: no file %s" % path)
        with open(path, "rb") as fh:
            return fh.read()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"})
    try:
        with open_url(req, timeout=timeout, allowed=MOEX_HOSTS | RU_NEWS_HOSTS) as resp:
            return resp.read()
    except NetError as exc:
        raise NewsError(str(exc))
    except urllib.error.HTTPError as exc:
        raise NewsError("HTTP %s for %s" % (exc.code, url))
    except urllib.error.URLError as exc:
        raise NewsError("could not reach %s: %s" % (url, exc.reason))


def parse_feed(data, source, parse_time):
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise NewsError("%s feed is not valid XML: %s" % (source, exc))

    def text(el, name):
        for c in el.iter():
            if c.tag.rsplit("}", 1)[-1] == name:
                return (c.text or "").strip()
        return ""
    out = []
    for it in root.iter("item"):
        title = html.unescape(re.sub(r"\s+", " ", text(it, "title")))
        link = text(it, "link")
        guid = text(it, "guid") or link
        summary = html.unescape(re.sub(r"<[^>]+>", " ", text(it, "description")))
        summary = re.sub(r"\s+", " ", summary).strip()
        out.append({"id": "%s:%s" % (source, guid or title), "source": source, "kind": "headline",
                    "ticker": "", "title": title, "summary": summary[:600], "link": link,
                    "time": parse_time(text(it, "pubDate"))})
    return out


# ---------------------------------------------------------------- matching

def load_aliases(path=None):
    path = path or os.path.join(HERE, "moex_aliases.json")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh).get("aliases", {})
    except (OSError, ValueError):
        return {}


def mention_patterns(watch, aliases):
    """ticker -> compiled regex of its Russian names (word stems) and the ticker itself."""
    pats = {}
    for t, name in watch.items():
        words = list(aliases.get(t, []))
        if name and len(name) >= 4:
            words.append(name)
        alts = [r"(?<![A-Za-z0-9])%s(?![A-Za-z0-9])" % re.escape(t)]  # the ticker as a token, e.g. "SBER"
        for w in words:
            w = w.strip()
            if not w:
                continue
            esc = re.escape(w).replace(r"\ ", r"\s+")
            alts.append(r"(?<![\w-])%s[а-яё]{0,3}(?![\w-])" % esc)  # Russian case endings only: Сбербанка, not Газпромбанк
        pats[t] = re.compile("|".join(alts), re.I | re.U)
    return pats


def tag(items, watch, aliases):
    pats = mention_patterns(watch, aliases)
    for it in items:
        hay = "%s %s" % (it["title"], it.get("summary") or "")
        it["touches"] = sorted(t for t, rx in pats.items() if rx.search(hay))
        it["tags"] = [label for label, rx in KEYWORDS if re.search(rx, hay, re.I | re.U)]
        it["market"] = bool(MARKET_TAGS & set(it["tags"]))
        it["important"] = bool(it["touches"]) and bool({"отчётность", "дивиденды", "риск", "сделка"} & set(it["tags"]))
    return items


def watch_from_files(news, portfolio, targets):
    return news.watch_from_files(portfolio, targets)


# ---------------------------------------------------------------- the check

def collect(feeds, offline, news, errors):
    items = []
    for key in feeds:
        label, url = FEEDS[key]
        try:
            items += parse_feed(fetch(url, offline, key), label, news.parse_time)
        except NewsError as exc:
            errors.append("%s: %s" % (label, exc))
    return items


def render(items, errors, now, watch):
    out = []
    if not items:
        out.append("Ничего нового.")
    for it in items:
        when = (it["time"].astimezone(_dt.timezone(_dt.timedelta(hours=3))).strftime("%d.%m %H:%M")
                if it["time"] else "время неизвестно")
        mark = "!" if it.get("important") else " "
        who = ",".join(it["touches"]) or ("рынок" if it.get("market") else "")
        out.append("%s %s  %-10s %-10s %s" % (mark, when, who, it["source"], it["title"]))
        extra = []
        if it["tags"]:
            extra.append("теги: " + ", ".join(it["tags"]))
        extra.append(it["link"])
        out.append("      " + "  ".join(extra))
    for e in errors:
        out.append("note: %s" % e)
    out.append("Проверено %s по Москве для %s. Заголовки это повод открыть источник, а не факт. "
               "Не инвестиционная рекомендация." % (
                   now.astimezone(_dt.timezone(_dt.timedelta(hours=3))).strftime("%d.%m %H:%M"),
                   ", ".join(sorted(watch)) or "рынка в целом"))
    return "\n".join(out) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="MOEX news monitor (trader-news)")
    ap.add_argument("--tickers", nargs="*", help="default: your portfolio, else your targets")
    ap.add_argument("--feeds", nargs="*", choices=sorted(FEEDS), default=None)
    ap.add_argument("--hours", type=float, default=48)
    ap.add_argument("--all", action="store_true", help="seen items too")
    ap.add_argument("--only-mine", action="store_true", help="skip market-wide items")
    ap.add_argument("--portfolio", default="trader/portfolio.json")
    ap.add_argument("--targets", default="trader/targets.json")
    ap.add_argument("--state", default="trader/state/moex_news.json")
    ap.add_argument("--no-write", action="store_true")
    ap.add_argument("--offline", metavar="DIR")
    ap.add_argument("--now", help="ISO time, for tests")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    news = load_news_module()
    now = (_dt.datetime.fromisoformat(a.now.replace("Z", "+00:00")) if a.now
           else _dt.datetime.now(_dt.timezone.utc))
    if now.tzinfo is None:
        now = now.replace(tzinfo=_dt.timezone.utc)
    watch = ({t.upper(): None for t in a.tickers} if a.tickers else watch_from_files(news, a.portfolio, a.targets))
    aliases = load_aliases()
    state = news.load_json(a.state) or {}
    errors = []
    items = collect(a.feeds or DEFAULT_FEEDS, a.offline, news, errors)
    items = tag(items, watch, aliases)
    items = [it for it in items if it["touches"] or (it["market"] and not a.only_mine)]
    items = news.dedupe(items)
    shown = news.select(items, state, now, hours=a.hours, show_all=a.all)
    if not a.no_write:
        news.remember(items, state, now)
        folder = os.path.dirname(a.state)
        if folder:
            os.makedirs(folder, exist_ok=True)
        with open(a.state, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, ensure_ascii=False)
    if a.json:
        print(json.dumps({"items": news._json_ready(shown), "errors": errors, "watch": sorted(watch)},
                         indent=2, ensure_ascii=False))
    else:
        sys.stdout.write(render(shown, errors, now, watch))
    return 0 if shown else 1


if __name__ == "__main__":
    sys.exit(main())
