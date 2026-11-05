"""The one network door for every trader-skill script. Standard library only.

Every script that goes online calls open_url() instead of urllib.request.urlopen():

  - https only;
  - the host must be on an allow list (the script passes its own, or ALL_HOSTS);
  - an HTTP redirect is followed only when the new host is on the same list,
    so a misbehaving or hijacked upstream cannot send our headers (the SEC
    User-Agent with your name and email, the broker token) anywhere else.

    from common.net import open_url, NetError, SEC_HOSTS
    with open_url(req, timeout=60, allowed=SEC_HOSTS) as resp:
        data = resp.read()
"""

import os
import ssl
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# T-Bank's certificates chain up to the Russian Trusted Root CA (Ministry of Digital
# Development), which Linux trust stores do not carry. We trust it for T-Bank hosts
# ONLY, on top of the system roots, never system-wide. Source: gu-st.ru (Gosuslugi),
# SHA-256 D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31
RUSSIAN_ROOT_PEM = os.path.join(HERE, "russian_trusted_root_ca.pem")
RUSSIAN_ROOT_SHA256 = "d26d2d0231b7c39f92cc738512ba54103519e4405d68b5bd703e9788ca8ecf31"

SEC_HOSTS = frozenset({"www.sec.gov", "data.sec.gov", "efts.sec.gov"})
HOUSE_HOSTS = frozenset({"disclosures-clerk.house.gov"})
QUOTE_HOSTS = frozenset({"query1.finance.yahoo.com", "query2.finance.yahoo.com",
                         "feeds.finance.yahoo.com", "stooq.com"})
FIGI_HOSTS = frozenset({"api.openfigi.com"})
TINVEST_HOSTS = frozenset({"invest-public-api.tbank.ru", "sandbox-invest-public-api.tbank.ru"})
TELEGRAM_HOSTS = frozenset({"api.telegram.org"})
MOEX_HOSTS = frozenset({"iss.moex.com", "www.moex.com"})   # the exchange's open data and notices
RU_NEWS_HOSTS = frozenset({"www.finam.ru", "www.interfax.ru", "rssexport.rbc.ru", "www.vedomosti.ru",
                           "www.kommersant.ru", "www.finmarket.ru", "1prime.ru"})
ALL_HOSTS = (SEC_HOSTS | HOUSE_HOSTS | QUOTE_HOSTS | FIGI_HOSTS | TINVEST_HOSTS | TELEGRAM_HOSTS
             | MOEX_HOSTS | RU_NEWS_HOSTS)


class NetError(Exception):
    pass


def check_url(url, allowed=ALL_HOSTS):
    """Raise NetError unless url is https and its host is on the allow list."""
    p = urllib.parse.urlparse(url)
    if p.scheme != "https":
        raise NetError("refusing %s: only https is allowed" % url)
    host = (p.hostname or "").lower()
    if host not in allowed:
        raise NetError("refusing %s: host %s is not on the allow list" % (url, host or "?"))
    return p


class _SameListRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to a host on the allow list."""

    def __init__(self, allowed):
        self.allowed = allowed

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl, self.allowed)
        return urllib.request.HTTPRedirectHandler.redirect_request(
            self, req, fp, code, msg, headers, newurl)


PROXY_VARS = (  # (hosts, environment variable), first match wins; TRADER_PROXY is the fallback
    (TELEGRAM_HOSTS, "TELEGRAM_PROXY"),
    (TINVEST_HOSTS, "TINVEST_PROXY"),
)


def proxy_setting(host):
    """The proxy setting for this host: "" (direct), "system", or a proxy URL.
    TELEGRAM_PROXY covers api.telegram.org, TINVEST_PROXY covers T-Bank, TRADER_PROXY
    covers everything else. Direct by default: T-Bank needs no proxy from Russia, and a
    system proxy with a password answers 407 to urllib. Telegram from Russia usually
    needs one: TELEGRAM_PROXY=http://user:pass@host:port, or "system"."""
    for hosts, var in PROXY_VARS:
        if host in hosts and os.environ.get(var, "").strip():
            return os.environ[var].strip()
    return os.environ.get("TRADER_PROXY", "").strip()


def proxy_handler(host=""):
    p = proxy_setting(host)
    if not p or p.lower() == "direct":
        return urllib.request.ProxyHandler({})
    if p.lower() == "system":
        return urllib.request.ProxyHandler()
    return urllib.request.ProxyHandler({"https": p, "http": p})


_CTX = {}


def ssl_context(host):
    """System roots for everyone; for T-Bank hosts also the Russian Trusted Root CA
    (bundled, or the file in TINVEST_CA_BUNDLE). Verification stays on."""
    key = "tinvest" if host in TINVEST_HOSTS else "default"
    if key not in _CTX:
        ctx = ssl.create_default_context()
        if key == "tinvest":
            extra = os.environ.get("TINVEST_CA_BUNDLE", "").strip() or RUSSIAN_ROOT_PEM
            if os.path.isfile(extra):
                ctx.load_verify_locations(cafile=extra)
        _CTX[key] = ctx
    return _CTX[key]


def open_url(req, timeout=60, allowed=ALL_HOSTS):
    """urlopen with the allow list. `req` is a urllib Request or a URL string.
    Returns the response (use it as a context manager). Raises NetError for a
    disallowed host, and urllib's HTTPError / URLError as usual."""
    url = req.full_url if isinstance(req, urllib.request.Request) else str(req)
    p = check_url(url, allowed)
    host = (p.hostname or "").lower()
    opener = urllib.request.build_opener(proxy_handler(host), _SameListRedirects(allowed),
                                         urllib.request.HTTPSHandler(context=ssl_context(host)))
    return opener.open(req, timeout=timeout)
