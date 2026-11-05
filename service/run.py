#!/usr/bin/env python3
"""Start the Telegram bot and the scheduler in one process.

    python3 service/run.py                 # service/config.json next to this file
    python3 service/run.py --config path   # another config
    python3 service/run.py --check         # config, tokens, bot identity, then exit

Environment: TELEGRAM_BOT_TOKEN, TINVEST_SANDBOX_TOKEN (and TINVEST_TOKEN only when
you go live). Nothing here places an order by itself.
"""

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from service.tg import Telegram, TgError  # noqa: E402
from service.pack import Pack  # noqa: E402
from service.bot import Bot  # noqa: E402
from service.scheduler import Scheduler  # noqa: E402
from service.web import Panel  # noqa: E402

COMMANDS = [("status", "среда, счёт, стоп-кран"), ("portfolio", "портфель"), ("quotes", "цены"),
            ("propose", "предложить ордера"), ("rebalance", "ребалансировка"), ("risk", "проверить ордера"),
            ("orders", "тикеты с кнопками"), ("alerts", "алерты сейчас"), ("news", "новости по бумагам"),
            ("metrics", "фундаментальные показатели"), ("screen", "отбор по правилам"), ("index", "скопировать индекс"),
            ("log", "решения за сегодня"), ("panel", "ссылка на панель"),
            ("jobs", "планировщик"), ("stop", "стоп-кран"), ("resume", "снять стоп-кран"), ("help", "команды")]


def load_config(path):
    if not os.path.isfile(path):
        raise SystemExit("no config at %s: copy service/config.example.json to service/config.json and fill it in" % path)
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    if not cfg.get("telegram", {}).get("allowed_user_ids"):
        print("WARNING: allowed_user_ids is empty. The bot will only answer /start with your id.", file=sys.stderr)
    return cfg


def poll_forever(tg, bot, sched, sleep=time.sleep):
    """Long polling. A network hiccup or one bad update must not kill the process:
    it is logged, we wait (1, 2, 4 ... 60 s) and poll again."""
    backoff = 1
    while True:
        try:
            for u in tg.updates():
                bot.handle(u)
            backoff = 1
        except KeyboardInterrupt:
            print("stopping")
            sched.stop.set()
            return 0
        except TgError as exc:
            print("telegram: %s" % exc, file=sys.stderr)
            sleep(backoff)
            backoff = min(backoff * 2, 60)
        except Exception as exc:  # last line of defence; systemd restart is the next one
            print("poll loop: %s: %s" % (exc.__class__.__name__, exc), file=sys.stderr)
            sleep(backoff)
            backoff = min(backoff * 2, 60)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Trader bot + scheduler")
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--check", action="store_true", help="verify config and tokens, then exit")
    a = ap.parse_args(argv)
    cfg = load_config(a.config)
    project = os.path.join(ROOT, cfg.get("project_dir", "."))
    pack = Pack(project, os.path.join(ROOT, cfg.get("pack_dir", "trader-skill")))
    try:
        tg = Telegram()
        me = tg.get_me()
    except TgError as exc:
        print("telegram: %s" % exc, file=sys.stderr)
        print("Telegram is not reachable directly from some networks. Set TELEGRAM_PROXY, or your own "
              "relay with TELEGRAM_API_BASE (docs/telegram-relay.md), and try again.", file=sys.stderr)
        return 2
    print("bot: @%s, project: %s%s" % (me.get("username"), pack.project,
                                        (", via relay " + tg.base) if tg.relayed else ""))
    code, out, err = pack.whoami()
    print(out.strip() or err.strip())
    if a.check:
        return 0 if code == 0 else 1
    allowed = cfg.get("telegram", {}).get("allowed_user_ids") or []
    chat_id = cfg.get("telegram", {}).get("chat_id") or (allowed[0] if allowed else None)

    def notify(text, silent=False):
        if chat_id:
            try:
                tg.send(chat_id, text, silent=silent)
            except TgError as exc:
                print("notify failed: %s" % exc, file=sys.stderr)

    sched = Scheduler(pack, notify, cfg)
    panel = None
    if (cfg.get("web") or {}).get("secret"):
        try:
            panel = Panel(pack, sched, cfg)
            if panel.enabled():
                panel.start()
                print("panel: %s" % panel.url())
            else:
                print("panel: web.secret must be at least 16 characters; panel off", file=sys.stderr)
                panel = None
        except OSError as exc:
            print("panel: cannot listen: %s" % exc, file=sys.stderr)
            panel = None
    bot = Bot(tg, pack, cfg, sched, panel)
    try:
        tg.set_commands(COMMANDS)
    except TgError:
        pass
    sched.start()
    notify("Сервис запущен. /status", silent=True)  # no sound: a restart is not news
    return poll_forever(tg, bot, sched)


if __name__ == "__main__":
    sys.exit(main())
