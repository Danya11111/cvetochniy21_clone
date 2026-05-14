#!/usr/bin/env bash
# Восстановление файла базы данных из резервной копии SQLite.
#
# ЖЁСТКИЕ СРЕДСТВА ЗАЩИТЫ:
#   CONFIRM_RESTORE=yes обязательна
#   SQLITE_DB_PATH — абсолютный путь к целевому файлу БД на ЭТОЙ машине (после остановки приложения)
#
# Использование (на НОВОМ сервере, приложение ОСТАНОВЛЕНО):
#   CONFIRM_RESTORE=yes SQLITE_DB_PATH=/var/lib/cvetochny21/app.sqlite SQLITE_RESTORE_SOURCE=/safe/f21-db-....sqlite \\
#      bash scripts/migration/restore.sh
#
set -euo pipefail

if [[ "${CONFIRM_RESTORE:-}" != "yes" ]]; then
  echo "[restore] REFUSED: set CONFIRM_RESTORE=yes to proceed (destructive)." >&2
  exit 1
fi

if [[ -z "${SQLITE_RESTORE_SOURCE:-}" ]]; then
  echo "[restore] ERROR: SQLITE_RESTORE_SOURCE is required (path to backup .sqlite file)" >&2
  exit 1
fi

if [[ -z "${SQLITE_DB_PATH:-}" ]]; then
  echo "[restore] ERROR: SQLITE_DB_PATH is required (absolute path to target DB file)" >&2
  exit 1
fi

if [[ "${SQLITE_DB_PATH}" != /* ]]; then
  echo "[restore] ERROR: SQLITE_DB_PATH must be an absolute path (got: ${SQLITE_DB_PATH})" >&2
  exit 1
fi

if [[ ! -f "${SQLITE_RESTORE_SOURCE}" ]]; then
  echo "[restore] ERROR: SQLITE_RESTORE_SOURCE not found: ${SQLITE_RESTORE_SOURCE}" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[restore] ERROR: sqlite3 CLI not found in PATH" >&2
  exit 1
fi

echo "[restore] Verifying integrity of backup BEFORE replacing target..."
chk="$(sqlite3 "${SQLITE_RESTORE_SOURCE}" "PRAGMA integrity_check;" | tr -d '\r')"
if [[ "${chk}" != "ok" ]]; then
  echo "[restore] ERROR: integrity_check on backup failed: ${chk}" >&2
  exit 1
fi

TARGET_DIR="$(dirname "${SQLITE_DB_PATH}")"
mkdir -p "${TARGET_DIR}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -f "${SQLITE_DB_PATH}" ]] || [[ -L "${SQLITE_DB_PATH}" ]]; then
  PRE_BACKUP="${SQLITE_DB_PATH}.pre_restore_${STAMP}"
  echo "[restore] Preserving current DB as ${PRE_BACKUP}"
  cp -a "${SQLITE_DB_PATH}" "${PRE_BACKUP}"
  # Также сохранить WAL/SHM рядом, если есть
  shopt -s nullglob
  for ext in -wal -shm; do
    if [[ -f "${SQLITE_DB_PATH}${ext}" ]]; then
      cp -a "${SQLITE_DB_PATH}${ext}" "${PRE_BACKUP}${ext}"
      echo "[restore] Preserved ${SQLITE_DB_PATH}${ext}"
    fi
  done
  shopt -u nullglob
fi

echo "[restore] Copying backup to ${SQLITE_DB_PATH}"
cp -a "${SQLITE_RESTORE_SOURCE}" "${SQLITE_DB_PATH}"

echo "[restore] Verifying restored file..."
sqlite3 "${SQLITE_DB_PATH}" "PRAGMA integrity_check;"

echo "[restore] DONE. Start the application and run validate.sh"
