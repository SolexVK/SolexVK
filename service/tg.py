"""Telegram Bot API client. Standard library only, long polling, no webhooks.

The bot token comes from TELEGRAM_BOT_TOKEN and is never printed. Every request
goes through common/net.py (https, api.telegram.org only, or your own relay).

Where api.telegram.org is unreachable, TELEGRAM_API_BASE points at your own
relay (a Cloudflare Worker that forwards to api.telegram.org, see
docs/telegram-relay.md) and TELEGRAM_RELAY_KEY is sent as X-Relay-Key so
nobody else can use it. The relay sees the bot token, so it must be yours.
"""

import http.client
import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "trader-skill"))
from common.net import open_url, NetError, TELEGRAM_HOSTS  # noqa: E402


class TgError(Exception):
    pass


def html(text):
    """Escape for parse_mode=HTML."""
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


DEFAULT_BASE = "https://api.telegram.org"


class Telegram(object):
    def __init__(self, token=None, transport=None, base=None, relay_key=None):
        self.token = token or os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        if not self.token:
            raise TgError("no bot token: set TELEGRAM_BOT_TOKEN (docs/telegram-setup.md)")
        self.base = (base or os.environ.get("TELEGRAM_API_BASE", "").strip() or DEFAULT_BASE).rstrip("/")
        self.relay_key = relay_key if relay_key is not None else os.environ.get("TELEGRAM_RELAY_KEY", "").strip()
        host = (urllib.parse.urlparse(self.base).hostname or "").lower()
        if not host or urllib.parse.urlparse(self.base).scheme != "https":
            raise TgError("TELEGRAM_API_BASE must be an https URL, got %r" % self.base)
        self.allowed = TELEGRAM_HOSTS | {host}
        self.relayed = host not in TELEGRAM_HOSTS
        self.transport = transport or self._post
        self.offset = None

    def url(self, method):
        return "%s/bot%s/%s" % (self.base, self.token, method)

    # ------------------------------------------------------------ transport
    def _post(self, method, payload, timeout):
        headers = {"Content-Type": "application/json"}
        if self.relayed and self.relay_key:
            headers["X-Relay-Key"] = self.relay_key
        req = urllib.request.Request(self.url(method), data=json.dumps(payload).encode("utf-8"), method="POST",
                                     headers=headers)
        host = urllib.parse.urlparse(self.base).hostname
        try:
            with open_url(req, timeout=timeout, allowed=self.allowed) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except NetError as exc:
            raise TgError(str(exc))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                body = json.loads(raw)
            except ValueError:
                raise TgError("%s: HTTP %d" % (method, exc.code))
        except urllib.error.URLError as exc:
            raise TgError("could not reach %s: %s" % (host, exc.reason))
        # A long poll that stalls mid-answer raises a bare timeout or a dropped
        # connection, not URLError. Before this they escaped, the process died
        # and systemd restarted it ("Сервис запущен" several times a night).
        except (socket.timeout, TimeoutError) as exc:
            raise TgError("%s: %s timed out: %s" % (method, host, exc))
        except (http.client.HTTPException, ConnectionError, OSError) as exc:
            raise TgError("%s: connection to %s broke: %s" % (method, host, exc.__class__.__name__))
        except ValueError as exc:  # a half-read or garbled answer that is not JSON
            raise TgError("%s: bad answer from %s: %s" % (method, host, exc))
        return body

    def call(self, method, payload=None, timeout=30):
        body = self.transport(method, payload or {}, timeout)
        if not body.get("ok"):
            desc = body.get("description", "unknown error")
            raise TgError("%s: %s" % (method, desc.replace(self.token, "<token>")))
        return body.get("result")

    # ------------------------------------------------------------ methods
    def get_me(self):
        return self.call("getMe")

    def updates(self, timeout=None):
        if timeout is None:
            timeout = 20 if self.relayed else 50  # a relay has its own limits on long requests
        payload = {"timeout": timeout, "allowed_updates": ["message", "callback_query"]}
        if self.offset is not None:
            payload["offset"] = self.offset
        res = self.call("getUpdates", payload, timeout=timeout + 10) or []
        for u in res:
            self.offset = max(self.offset or 0, u["update_id"] + 1)
        return res

    def send(self, chat_id, text, buttons=None, silent=False):
        payload = {"chat_id": chat_id, "text": text[:4000], "parse_mode": "HTML",
                   "disable_web_page_preview": True, "disable_notification": silent}
        if buttons:
            payload["reply_markup"] = {"inline_keyboard": buttons}
        return self.call("sendMessage", payload)

    def edit(self, chat_id, message_id, text, buttons=None):
        payload = {"chat_id": chat_id, "message_id": message_id, "text": text[:4000], "parse_mode": "HTML",
                   "disable_web_page_preview": True}
        payload["reply_markup"] = {"inline_keyboard": buttons or []}
        try:
            return self.call("editMessageText", payload)
        except TgError as exc:
            if "message is not modified" in str(exc):
                return None
            raise

    def answer(self, callback_id, text=None, alert=False):
        payload = {"callback_query_id": callback_id}
        if text:
            payload["text"] = text[:200]
            payload["show_alert"] = alert
        try:
            return self.call("answerCallbackQuery", payload)
        except TgError:
            return None  # an old callback; nothing to do

    def set_menu_button(self, chat_id, text, url):
        """A persistent "open the panel" button next to the input field (Telegram Mini App; https only)."""
        return self.call("setChatMenuButton", {"chat_id": chat_id,
                                               "menu_button": {"type": "web_app", "text": text, "web_app": {"url": url}}})

    def set_commands(self, commands):
        return self.call("setMyCommands", {"commands": [{"command": c, "description": d} for c, d in commands]})


def button(text, data):
    return {"text": text, "callback_data": data[:64]}
