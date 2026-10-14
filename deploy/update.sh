#!/usr/bin/env bash
# Updates LULU on the server to the newest code (docs/operations.md). Run as root:
#   sudo /srv/lulu/deploy/update.sh
# Takes a database backup first, then pulls, installs, builds and restarts. Database
# migrations run by themselves when the services start.
set -euo pipefail
cd "$(dirname "$0")/.."
as_lulu() { sudo -u lulu -H "$@"; }

echo '① بکاپ دیتابیس پیش از به‌روزرسانی…'
PG_BACKUP_DIR=/var/backups/lulu scripts/server/pg-backup.sh

echo '② گرفتن کد تازه…'
as_lulu git pull --ff-only

echo '③ نصب وابستگی‌ها و ساخت…'
as_lulu npm ci --no-audit --no-fund
as_lulu npm run build

echo '④ روشن کردن دوباره…'
systemctl restart lulu-api lulu-worker lulu-bot
sleep 5
systemctl --no-pager --lines=0 status lulu-api lulu-worker lulu-bot | grep -E '●|Active:'
echo '✅ تمام شد. اگر سرویسی active (running) نیست: journalctl -u lulu-bot -n 50'
