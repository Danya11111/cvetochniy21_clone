#!/usr/bin/env bash
# Создание согласованной копии SQLite через API .backup.
# Перед запуском остановите процесс приложения или убедитесь, что нет активной записи (см. docs/database-migration-ru-to-new-server.md).
#
# Использование:
#   F21_SQLITE_PATH=/path/to/app.sqlite bash scripts/migration/backup.sh
#   SQLITE_SOURCE=/path/db.sqlite BACKUP_DIR=/tmp/f21-backups bash scripts/migration/backup.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SQLITE_SOURCE="${SQLITE_SOURCE:-${F21_SQLITE_PATH:-}}"
if [[ -z "${SQLITE_SOURCE}" ]]; then
  SQLITE_SOURCE="${REPO_ROOT}/backend/database.sqlite"
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[backup] ERROR: sqlite3 CLI not found in PATH" >&2
  exit 1
fi

if [[ ! -f "${SQLITE_SOURCE}" ]]; then
  echo "[backup] ERROR: source database file not found: ${SQLITE_SOURCE}" >&2
  echo "[backup] Hint: set F21_SQLITE_PATH or SQLITE_SOURCE to your production .sqlite path" >&2
  exit 1
fi

BACKUP_ROOT="${BACKUP_DIR:-${REPO_ROOT}/backups}"
mkdir -p "${BACKUP_ROOT}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_PATH="${BACKUP_ROOT}/f21-db-${STAMP}.sqlite"

echo "[backup] Source: ${SQLITE_SOURCE}"
echo "[backup] Destination: ${BACKUP_PATH}"

# .backup выполняется в процессе sqlite3 источника; создаётся новый согласованный файл.
sqlite3 "${SQLITE_SOURCE}" <<SQL
.backup '${BACKUP_PATH}'
SQL

echo "[backup] Running integrity_check on backup..."
sqlite3 "${BACKUP_PATH}" "PRAGMA integrity_check;"

echo "[backup] DONE: ${BACKUP_PATH}"
echo "[backup] Do NOT commit this file; backups/ must stay out of Git."
