#!/usr/bin/env bash
# Install or update the trading service on a Linux server (Debian/Ubuntu, systemd).
# Run as root:  sudo bash deploy/install.sh
# Idempotent: safe to run again after `git pull` to update the code.
set -euo pipefail

APP=/opt/trader/app
ENVFILE=/opt/trader/env
REPO_URL="${REPO_URL:-https://github.com/SolexVK/SolexVK.git}"
BRANCH="${BRANCH:-Трейдинг-с-ИИ}"
# users who may READ the data folder and WRITE to inbox/ (the analyst agent), never the tokens
READERS="${READERS:-deploy}"

if [ "$(id -u)" -ne 0 ]; then echo "run as root: sudo bash $0"; exit 1; fi
command -v python3 >/dev/null || { echo "python3 is missing: apt-get install -y python3"; exit 1; }
command -v git >/dev/null || { echo "git is missing: apt-get install -y git"; exit 1; }

# 1. a user of its own, no login shell, no home we care about
id trader >/dev/null 2>&1 || useradd --system --home /opt/trader --shell /usr/sbin/nologin trader
mkdir -p /opt/trader
chown trader:trader /opt/trader
chmod 755 /opt/trader   # code and docs readable by everyone; secrets and data are locked below

# 2. the code, as the trader user (git refuses a repo owned by someone else)
as_trader() { runuser -u trader -- "$@"; }
if [ ! -d "$APP/.git" ]; then
  as_trader git clone --branch "$BRANCH" "$REPO_URL" "$APP"
else
  chown -R trader:trader "$APP/.git"
  as_trader git -C "$APP" fetch origin "$BRANCH"
  as_trader git -C "$APP" checkout -q "$BRANCH"
  as_trader git -C "$APP" merge -q --ff-only "origin/$BRANCH"
fi

# 3. data folder and configs (kept across updates, never overwritten)
mkdir -p "$APP/trader/state"
[ -f "$APP/trader/config.json" ] || cp "$APP/trader-skill/trader-tinvest/config.example.json" "$APP/trader/config.json"
[ -f "$APP/service/config.json" ] || cp "$APP/service/config.example.json" "$APP/service/config.json"
if [ ! -f "$ENVFILE" ]; then
  cp "$APP/deploy/env.example" "$ENVFILE"
  echo "NOTE: put the real tokens into $ENVFILE (nano $ENVFILE)"
fi
# 3b. the analyst's door: inbox/ is where another user (Sirius) drops targets.json;
#     the data folder is readable by the trader group, the tokens by trader only
mkdir -p "$APP/trader/inbox"
for u in $READERS; do
  if id "$u" >/dev/null 2>&1; then usermod -aG trader "$u"; echo "user $u may read trader/ and write trader/inbox/"; fi
done
chown -R trader:trader /opt/trader
chmod 755 /opt/trader
chmod 600 "$ENVFILE"
chmod 755 "$APP"            # code readable by everyone, no secrets in it
chmod 750 "$APP/trader"     # data: trader writes, the trader group reads
chmod 2770 "$APP/trader/inbox"   # inbox: the group writes too; new files inherit the group
find "$APP/trader" -type f -exec chmod 640 {} +
find "$APP/trader" -type d -not -path "$APP/trader/inbox" -exec chmod 750 {} +

# 4. the service
cp "$APP/deploy/trader.service" /etc/systemd/system/trader.service
systemctl daemon-reload
systemctl enable trader >/dev/null

echo
echo "Installed. Users added to the trader group see it only in NEW sessions;"
echo "until then they can read the data with:  sg trader -c 'cat /opt/trader/app/trader/portfolio.json'"
echo
echo "Next:"
echo "  nano $ENVFILE                      # tokens"
echo "  nano $APP/trader/config.json       # account_id"
echo "  nano $APP/service/config.json      # allowed_user_ids"
echo "  sudo -u trader bash -c 'set -a; . $ENVFILE; set +a; cd $APP && python3 service/run.py --check'"
echo "  systemctl restart trader && journalctl -u trader -f"
