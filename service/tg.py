"""Telegram Bot API client. Standard library only, long polling, no webhooks.

The bot token comes from TELEGRAM_BOT_TOKEN and is never printed. Every request
goes through common/net.py (https, api.telegram.org only).
"""

import json
import os
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


class Telegram(object):
    def __init__(self, token=None, transport=None):
        self.token = token or os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        if not self.token:
            raise TgError("no bot token: set TELEGRAM_BOT_TOKEN (docs/telegram-setup.md)")
        self.transport = transport or self._post
        self.offset = None

    # ------------------------------------------------------------ transport
    def _post(self, method, payload, timeout):
        url = "https://api.telegram.org/bot%s/%s" % (self.token, method)
        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with open_url(req, timeout=timeout, allowed=TELEGRAM_HOSTS) as resp:
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
            raise TgError("could not reach api.telegram.org: %s" % exc.reason)
        return body

    def call(self, method, timeout=30, **payload):
        body = self.transport(method, payload, timeout)
        if not body.get("ok"):
            desc = body.get("description", "unknown error")
            raise TgError("%s: %s" % (method, desc.replace(self.token, "<token>")))
        return body.get("result")

    # ------------------------------------------------------------ methods
    def get_me(self):
        return self.call("getMe")

    def updates(self, timeout=50):
        payload = {"timeout": timeout, "allowed_updates": ["message", "callback_query"]}
        if self.offset is not None:
            payload["offset"] = self.offset
        res = self.call("getUpdates", timeout=timeout + 10, **payload) or []
        for u in res:
            self.offset = max(self.offset or 0, u["update_id"] + 1)
        return res

    def send(self, chat_id, text, buttons=None, silent=False):
        payload = {"chat_id": chat_id, "text": text[:4000], "parse_mode": "HTML",
                   "disable_web_page_preview": True, "disable_notification": silent}
        if buttons:
            payload["reply_markup"] = {"inline_keyboard": buttons}
        return self.call("sendMessage", **payload)

    def edit(self, chat_id, message_id, text, buttons=None):
        payload = {"chat_id": chat_id, "message_id": message_id, "text": text[:4000], "parse_mode": "HTML",
                   "disable_web_page_preview": True}
        payload["reply_markup"] = {"inline_keyboard": buttons or []}
        try:
            return self.call("editMessageText", **payload)
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
            return self.call("answerCallbackQuery", **payload)
        except TgError:
            return None  # an old callback; nothing to do

    def set_commands(self, commands):
        return self.call("setMyCommands", commands=[{"command": c, "description": d} for c, d in commands])


def button(text, data):
    return {"text": text, "callback_data": data[:64]}
