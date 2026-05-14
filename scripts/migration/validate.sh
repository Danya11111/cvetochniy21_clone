#!/usr/bin/env bash
# Проверка целостности SQLite и вывод COUNT по ключевым таблицам проекта «Цветочный 21».
#
# Использование:
#   F21_SQLITE_PATH=/path/to/db.sqlite bash scripts/migration/validate.sh
#   SQLITE_DB_PATH=/path/to/db.sqlite bash scripts/migration/validate.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DB_PATH="${SQLITE_DB_PATH:-${F21_SQLITE_PATH:-}}"
if [[ -z "${DB_PATH}" ]]; then
  DB_PATH="${REPO_ROOT}/backend/database.sqlite"
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[validate] ERROR: sqlite3 CLI not found in PATH" >&2
  exit 1
fi

if [[ ! -f "${DB_PATH}" ]]; then
  echo "[validate] ERROR: database file not found: ${DB_PATH}" >&2
  exit 1
fi

echo "[validate] Database: ${DB_PATH}"

echo "[validate] PRAGMA integrity_check"
RESULT="$(sqlite3 "${DB_PATH}" "PRAGMA integrity_check;" | tr -d '\r')"
echo "${RESULT}"
if [[ "${RESULT}" != "ok" ]]; then
  echo "[validate] FAILED: integrity_check" >&2
  exit 1
fi

echo "[validate] PRAGMA quick_check"
QRESULT="$(sqlite3 "${DB_PATH}" "PRAGMA quick_check;" | tr -d '\r')"
echo "${QRESULT}"
if [[ "${QRESULT}" != "ok" ]]; then
  echo "[validate] FAILED: quick_check" >&2
  exit 1
fi

# Таблицы из backend/db.js (основной контур + миграции). Для отсутствующих — NULL count.
TABLES=(
  users
  addresses
  orders
  products
  payments
  telegram_topics
  event_outbox
  broadcast_campaigns
  broadcast_deliveries
  broadcast_trigger_audit
  broadcast_campaign_events
  support_threads
  support_messages
  runtime_flags
  admin_users
  admin_action_logs
  abandoned_carts
  promotion_sources
  promotion_source_clicks
  promotion_broadcasts
  promotion_broadcast_images
  promotion_broadcast_responses
  telegram_processed_updates
  support_response_windows
)

echo "[validate] Table counts (missing table => skipped)"
for t in "${TABLES[@]}"; do
  exists="$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${t}';")"
  if [[ "${exists}" == "1" ]]; then
    cnt="$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM \"${t}\";")"
    printf '  %-40s %s\n' "${t}" "${cnt}"
  else
    printf '  %-40s %s\n' "${t}" "(absent)"
  fi
done

ac_exists="$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='abandoned_carts';")"
if [[ "${ac_exists}" == "1" ]]; then
  echo "[validate] abandoned_carts by status"
  sqlite3 "${DB_PATH}" "SELECT printf('%s: %s', status, COUNT(*)) FROM abandoned_carts GROUP BY status ORDER BY status;" |
    while IFS= read -r line; do
      printf '  %s\n' "${line}"
    done
fi

echo "[validate] Note: there is NO order_items table; line items live in orders.items_json"
echo "[validate] OK"
