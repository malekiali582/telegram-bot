#!/usr/bin/env bash
# Full PostgreSQL backup of LULU with pg_dump (custom format), for the server's cron.
# Restore with pg_restore: see docs/backup.md.
#
#   scripts/server/pg-backup.sh                  # PostgreSQL in docker compose (default)
#   PG_BACKUP_VIA=local scripts/server/pg-backup.sh   # pg_dump on this host, DATABASE_URL
#
# Settings (environment): PG_BACKUP_DIR (backups/pg), PG_BACKUP_KEEP_DAYS (14).
# Example crontab line, every night at 03:30 server time:
#   30 3 * * * cd /srv/lulu && scripts/server/pg-backup.sh >> backups/pg/backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/../.."
DIR="${PG_BACKUP_DIR:-backups/pg}"
KEEP_DAYS="${PG_BACKUP_KEEP_DAYS:-14}"
VIA="${PG_BACKUP_VIA:-docker}"

umask 077 # backups hold every player's data: owner-only files
mkdir -p "$DIR"
STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
FILE="$DIR/lulu-$STAMP.dump"
trap 'rm -f "$FILE.partial"' EXIT

if [ "$VIA" = "docker" ]; then
  # Credentials come from the container's own environment; nothing is put on the command line.
  # shellcheck disable=SC2016
  docker compose exec -T postgres sh -c \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --compress=6' \
    > "$FILE.partial"
  # The dump must be readable before it replaces anything.
  docker compose exec -T postgres pg_restore --list < "$FILE.partial" > /dev/null
else
  : "${DATABASE_URL:?set DATABASE_URL (or load .env) for PG_BACKUP_VIA=local}"
  pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --compress=6 --file="$FILE.partial"
  pg_restore --list "$FILE.partial" > /dev/null
fi

mv "$FILE.partial" "$FILE"
(cd "$DIR" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256")
find "$DIR" -maxdepth 1 -name 'lulu-*.dump*' -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
