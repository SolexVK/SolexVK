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

COMMANDS = [("status", "среда, счёт, стоп-кран"), ("portfolio", "портфель"), ("quotes", "цены"),
            ("propose", "предложить ордера"), ("rebalance", "ребалансировка"), ("risk", "проверить ордера"),
            ("orders", "тикеты с кнопками"), ("alerts", "алерты сейчас"), ("log", "решения за сегодня"),
            ("jobs", "планировщик"), ("stop", "стоп-кран"), ("resume", "снять стоп-кран"), ("help", "команды")]


def load_config(path):
    if not os.path.isfile(path):
        raise SystemExit("no config at %s: copy service/config.example.json to service/config.json and fill it in" % path)
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    if not cfg.get("telegram", {}).get("allowed_user_ids"):
        print("WARNING: allowed_user_ids is empty. The bot will only answer /start with your id.", file=sys.stderr)
    return cfg


def main(argv=None):
    ap = argparse.ArgumentParser(description="Trader bot + scheduler")
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--check", action="store_true", help="verify config and tokens, then exit")
    a = ap.parse_args(argv)
    cfg = load_config(a.config)
    project = os.path.join(ROOT, cfg.get("project_dir", "."))
    pack = Pack(project, os.path.join(ROOT, cfg.get("pack_dir", "trader-skill")))
    tg = Telegram()
    me = tg.get_me()
    print("bot: @%s, project: %s" % (me.get("username"), pack.project))
    code, out, err = pack.whoami()
    print(out.strip() or err.strip())
    if a.check:
        return 0 if code == 0 else 1
    allowed = cfg.get("telegram", {}).get("allowed_user_ids") or []
    chat_id = cfg.get("telegram", {}).get("chat_id") or (allowed[0] if allowed else None)

    def notify(text):
        if chat_id:
            try:
                tg.send(chat_id, text)
            except TgError as exc:
                print("notify failed: %s" % exc, file=sys.stderr)

    sched = Scheduler(pack, notify, cfg)
    bot = Bot(tg, pack, cfg, sched)
    try:
        tg.set_commands(COMMANDS)
    except TgError:
        pass
    sched.start()
    notify("Сервис запущен. /status")
    backoff = 1
    while True:
        try:
            for u in tg.updates():
                bot.handle(u)
            backoff = 1
        except TgError as exc:
            print("telegram: %s" % exc, file=sys.stderr)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
        except KeyboardInterrupt:
            print("stopping")
            sched.stop.set()
            return 0


if __name__ == "__main__":
    sys.exit(main())
