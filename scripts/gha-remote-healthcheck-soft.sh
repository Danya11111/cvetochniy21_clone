#!/usr/bin/env bash
# Неблокирующий curl к публичному URL из .env (см. docs/github-actions-ssh-deploy.md).
# DEPLOY_PATH задаётся в вызове ssh (DEPLOY_PATH=<printf %q> bash -se).
set -euo pipefail
: "${DEPLOY_PATH:?DEPLOY_PATH is required}"
set +e
cd "$DEPLOY_PATH" || { echo "Healthcheck skipped: cannot cd to DEPLOY_PATH"; exit 0; }
if ! command -v curl >/dev/null 2>&1; then
  echo "Healthcheck skipped: curl not installed on server"
  exit 0
fi
if [ ! -f .env ]; then
  echo "Healthcheck skipped: no .env in DEPLOY_PATH (expected managed on server)"
  exit 0
fi
APP_URL=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    APP_PUBLIC_URL=*|BASE_URL=*)
      APP_URL="${line#*=}"
      APP_URL="${APP_URL%%#*}"
      APP_URL="$(printf '%s' "$APP_URL" | tr -d '\r')"
      APP_URL="${APP_URL#\"}"
      APP_URL="${APP_URL%\"}"
      APP_URL="${APP_URL#\'}"
      APP_URL="${APP_URL%\'}"
      APP_URL="${APP_URL%/}"
      break
      ;;
  esac
done < .env
if [ -z "$APP_URL" ]; then
  echo "Healthcheck skipped: APP_PUBLIC_URL/BASE_URL not found in .env"
  exit 0
fi
for hp in /api/health/ops /health; do
  url="${APP_URL}${hp}"
  if curl -fsS --max-time 15 "$url" >/dev/null; then
    echo "Healthcheck OK: $url"
    exit 0
  fi
done
echo "Healthcheck skipped or failed (non-fatal): tried ${APP_URL}/api/health/ops and ${APP_URL}/health"
exit 0
