#!/bin/bash
# Автообновление «Тайцзи» на сервере: забирает новую версию из GitHub (ветка Тай-Чи).
# Приложение (папка docs) Caddy раздаёт сразу; если изменился код сервера — ставим зависимости и перезапускаем службу.
# Устанавливается копией в /usr/local/sbin (см. server/README.md), запускается таймером taichi-update.timer.
set -euo pipefail
cd "${TAICHI_DIR:-/opt/taichi}"
git fetch --quiet origin 'Тай-Чи'
old=$(git rev-parse HEAD)
new=$(git rev-parse FETCH_HEAD)
[ "$old" = "$new" ] && exit 0
git merge --ff-only --quiet FETCH_HEAD
changed=$(git diff --name-only "$old" "$new")
if grep -q '^server/package' <<<"$changed"; then
  (cd server && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
fi
if grep -q '^server/' <<<"$changed"; then
  systemctl restart taichi
fi
echo "Тайцзи обновлено: ${old:0:7} -> ${new:0:7}"
