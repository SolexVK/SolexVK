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

import urllib.error
import urllib.parse
import urllib.request

SEC_HOSTS = frozenset({"www.sec.gov", "data.sec.gov", "efts.sec.gov"})
HOUSE_HOSTS = frozenset({"disclosures-clerk.house.gov"})
QUOTE_HOSTS = frozenset({"query1.finance.yahoo.com", "query2.finance.yahoo.com",
                         "feeds.finance.yahoo.com", "stooq.com"})
FIGI_HOSTS = frozenset({"api.openfigi.com"})
TINVEST_HOSTS = frozenset({"invest-public-api.tbank.ru", "sandbox-invest-public-api.tbank.ru"})
ALL_HOSTS = SEC_HOSTS | HOUSE_HOSTS | QUOTE_HOSTS | FIGI_HOSTS | TINVEST_HOSTS


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


def open_url(req, timeout=60, allowed=ALL_HOSTS):
    """urlopen with the allow list. `req` is a urllib Request or a URL string.
    Returns the response (use it as a context manager). Raises NetError for a
    disallowed host, and urllib's HTTPError / URLError as usual."""
    url = req.full_url if isinstance(req, urllib.request.Request) else str(req)
    check_url(url, allowed)
    opener = urllib.request.build_opener(_SameListRedirects(allowed))
    return opener.open(req, timeout=timeout)
