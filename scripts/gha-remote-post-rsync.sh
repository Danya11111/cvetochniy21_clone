#!/usr/bin/env bash
# CI: ssh ... "DEPLOY_PATH=<quoted> bash -se" < scripts/gha-remote-post-rsync.sh
set -euo pipefail
: "${DEPLOY_PATH:?DEPLOY_PATH is required}"
cd "$DEPLOY_PATH"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
if systemctl cat cvetochniy21.service &>/dev/null; then
  sudo systemctl restart cvetochniy21.service
elif systemctl cat cvet21.service &>/dev/null; then
  sudo systemctl restart cvet21.service
elif systemctl cat f21.service &>/dev/null; then
  sudo systemctl restart f21.service
elif command -v pm2 >/dev/null 2>&1 && pm2 describe cvetochniy21 >/dev/null 2>&1; then
  pm2 restart cvetochniy21
elif command -v pm2 >/dev/null 2>&1 && pm2 describe cvet21 >/dev/null 2>&1; then
  pm2 restart cvet21
elif command -v pm2 >/dev/null 2>&1 && pm2 describe f21 >/dev/null 2>&1; then
  pm2 restart f21
else
  echo "No known process manager found. Configure systemd service cvetochniy21.service, cvet21.service, f21.service, or pm2 process cvetochniy21/cvet21/f21."
  exit 1
fi
