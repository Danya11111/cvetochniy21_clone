#!/usr/bin/env bash
# Remote verification after rsync: fail fast if DEPLOY_PATH content does not match this CI run.
# Env on remote: DEPLOY_PATH (required), VERIFY_EXPECT_SHA (full git sha).
set -euo pipefail

: "${DEPLOY_PATH:?DEPLOY_PATH is required on remote}"
: "${VERIFY_EXPECT_SHA:?VERIFY_EXPECT_SHA is required on remote}"

fail() {
  echo "Remote files do not match expected deployed commit/path." >&2
  echo "Reason: $*" >&2
  exit 1
}

DI_JSON="${DEPLOY_PATH}/frontend/deploy-info.json"
IDX_HTML="${DEPLOY_PATH}/frontend/index.html"
APP_JS="${DEPLOY_PATH}/frontend/app.js"

test -f "$DI_JSON" || fail "missing ${DI_JSON}"
test -f "$IDX_HTML" || fail "missing ${IDX_HTML}"
test -f "$APP_JS" || fail "missing ${APP_JS}"

if ! command -v node >/dev/null 2>&1; then
  fail "node is required on the server to verify frontend/deploy-info.json"
fi

COMMIT_ON_DISK="$(node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j.commit||''));" "$DI_JSON")"

test -n "$COMMIT_ON_DISK" || fail "empty commit in frontend/deploy-info.json"

if [ "$COMMIT_ON_DISK" != "$VERIFY_EXPECT_SHA" ]; then
  fail "frontend/deploy-info.json commit mismatch (got=${COMMIT_ON_DISK}, expected=${VERIFY_EXPECT_SHA})"
fi

if grep -Fq "Телефон (Введите номер с цифры 9)" "$IDX_HTML"; then
  fail "stale phone label string found in frontend/index.html"
fi

if grep -Fq ">Отмена<" "$IDX_HTML"; then
  fail "stale cancel markup '>Отмена<' found in frontend/index.html"
fi

if grep -Fq "Не удалось передать заказ в МойСклад" "$APP_JS"; then
  fail "stale user-facing MoySklad alert string found in frontend/app.js"
fi

echo "[gha-remote-verify-deploy] OK sha=${VERIFY_EXPECT_SHA} path=${DEPLOY_PATH}"
