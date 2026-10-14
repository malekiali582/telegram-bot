#!/usr/bin/env bash
# Writes the production .env for LULU with fresh random secrets (docs/server-setup.md).
# Asks for the domain, the bot token and the first panel account; never overwrites an
# existing file. Non-interactive use: LULU_DOMAIN, LULU_BOT_TOKEN, LULU_ADMIN_USER and
# LULU_ADMIN_PASSWORD in the environment; ENV_FILE picks the output (default: .env).
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env}"

if [ -e "$ENV_FILE" ]; then
  echo "❌ $ENV_FILE از قبل هست؛ دست نمی‌زنم. اگر واقعاً می‌خواهید از نو بسازید، اول آن را جابه‌جا کنید."
  exit 1
fi

ask() { # ask <variable> <prompt> [silent]
  local value="${!1:-}"
  while [ -z "$value" ]; do
    if [ "${3:-}" = silent ]; then read -r -s -p "$2: " value; echo; else read -r -p "$2: " value; fi
  done
  printf -v "$1" '%s' "$value"
}

ask LULU_DOMAIN 'دامنهٔ پنل و ربات (مثلاً lulu.example.com)'
LULU_DOMAIN="$(printf '%s' "$LULU_DOMAIN" | tr 'A-Z' 'a-z' | sed -e 's#^https\?://##' -e 's#/.*$##')"
if ! [[ "$LULU_DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "❌ دامنه درست نیست: $LULU_DOMAIN"
  exit 1
fi
ask LULU_BOT_TOKEN 'توکن ربات از BotFather (موقع تایپ دیده نمی‌شود)' silent
if ! [[ "$LULU_BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; then
  echo '❌ این شبیه توکن BotFather نیست (عدد، دونقطه، و دست‌کم ۳۰ نویسه).'
  exit 1
fi
ask LULU_ADMIN_USER 'نام کاربری مالک پنل (حروف کوچک انگلیسی، رقم، _ . -)'
if ! [[ "$LULU_ADMIN_USER" =~ ^[a-z0-9_.-]{3,32}$ ]]; then
  echo '❌ نام کاربری باید ۳ تا ۳۲ نویسه از a-z، 0-9 و _ . - باشد.'
  exit 1
fi
GENERATED_PASSWORD=''
if [ -z "${LULU_ADMIN_PASSWORD:-}" ]; then
  read -r -s -p 'رمز مالک پنل (دست‌کم ۱۲ نویسه؛ خالی بگذارید تا خودکار ساخته شود): ' LULU_ADMIN_PASSWORD || true
  echo
fi
if [ -z "$LULU_ADMIN_PASSWORD" ]; then
  LULU_ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
  GENERATED_PASSWORD="$LULU_ADMIN_PASSWORD"
fi
if [ "${#LULU_ADMIN_PASSWORD}" -lt 12 ]; then
  echo '❌ رمز باید دست‌کم ۱۲ نویسه باشد.'
  exit 1
fi

# Hex secrets need no escaping anywhere (URLs, systemd, docker compose).
DB_PASSWORD="$(openssl rand -hex 24)"
SESSION_SECRET="$(openssl rand -hex 48)"
WEBHOOK_SECRET="$(openssl rand -hex 32)"

umask 077 # secrets: readable by the owner only
cat > "$ENV_FILE" <<ENV
# LULU — production settings, made by deploy/make-env.sh on $(date -u +%F).
# Secrets live here only: never share or commit this file.
NODE_ENV=production
LOG_LEVEL=info

# PostgreSQL (docker compose, reachable on this server only)
POSTGRES_USER=lulu
POSTGRES_PASSWORD=$DB_PASSWORD
POSTGRES_DB=lulu
POSTGRES_PORT=5432
DATABASE_URL=postgres://lulu:$DB_PASSWORD@127.0.0.1:5432/lulu

# Telegram (webhook through Caddy)
TELEGRAM_BOT_TOKEN=$LULU_BOT_TOKEN
TELEGRAM_MODE=webhook
PUBLIC_BASE_URL=https://$LULU_DOMAIN
TELEGRAM_WEBHOOK_SECRET=$WEBHOOK_SECRET
TELEGRAM_WEBHOOK_HOST=127.0.0.1
TELEGRAM_WEBHOOK_PORT=8443

# API and admin panel (behind Caddy on the same domain)
API_HOST=127.0.0.1
API_PORT=3000
ADMIN_ORIGIN=https://$LULU_DOMAIN
SESSION_SECRET=$SESSION_SECRET
COOKIE_SECURE=true
API_TRUST_PROXY=127.0.0.1

# First owner account: read once by npm run admin:bootstrap; delete these two lines after.
ADMIN_BOOTSTRAP_USERNAME=$LULU_ADMIN_USER
ADMIN_BOOTSTRAP_PASSWORD=$LULU_ADMIN_PASSWORD

# Backups made from the panel (the nightly pg_dump goes to /var/backups/lulu)
BACKUP_DIR=backups
BACKUP_KEEP=10

WORKER_OUTBOX_INTERVAL_MS=1000
ENV

echo "✅ $ENV_FILE ساخته شد (فقط برای صاحب فایل خواندنی است)."
echo "   آدرس پنل: https://$LULU_DOMAIN"
echo "   نام کاربری پنل: $LULU_ADMIN_USER"
if [ -n "$GENERATED_PASSWORD" ]; then
  echo "   رمز پنل (خودکار ساخته شد؛ همین حالا جایی امن یادداشت کنید): $GENERATED_PASSWORD"
fi
