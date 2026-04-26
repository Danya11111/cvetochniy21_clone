# Тестовый запуск в Нидерландах (arhipovdan.ru)

Домен: `https://arhipovdan.ru`  
IP сервера: `78.17.46.145` (пример; проверьте у провайдера)  

**Секреты** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, F21, Moysklad, T-Bank) задаются **только** на сервере в `/etc/cvetochny21.env`. **Не** коммитить реальные токены в репозиторий.

**Генерация длинного secret (для `TELEGRAM_WEBHOOK_SECRET` / по желанию `F21_ADMIN_OPEN_SECRET`):**
```bash
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=' | cut -c1-48
```

---

## A. DNS

| Имя | Тип | Значение |
|-----|-----|----------|
| `arhipovdan.ru` | A | `78.17.46.145` |
| `www.arhipovdan.ru` | A или CNAME | `78.17.46.145` или `arhipovdan.ru` |

---

## B. Пакеты (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y git nginx curl ca-certificates certbot python3-certbot-nginx ripgrep sqlite3 build-essential
```

---

## C. Node.js 20 (если Node &lt; 18 или нет `node`)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

---

## D. Клонирование и проверка репозитория

```bash
sudo mkdir -p /var/www
sudo chown "$USER":www-data /var/www
cd /var/www
git clone <YOUR_GIT_URL> cvetochny21_tg
cd /var/www/cvetochny21_tg
npm ci
npm run verify:manifest
```

---

## E. SQLite (каталог и файл БД)

```bash
sudo install -d -o www-data -g www-data -m 750 /var/lib/cvetochny21
sudo touch /var/lib/cvetochny21/database.sqlite
sudo chown www-data:www-data /var/lib/cvetochny21/database.sqlite
sudo chmod 640 /var/lib/cvetochny21/database.sqlite
```

---

## F. Env

```bash
sudo cp deploy/cvetochny21.env.test-migration.example /etc/cvetochny21.env
sudo nano /etc/cvetochny21.env
```

- Вручную вставьте **реальный** `TELEGRAM_BOT_TOKEN` тестового бота.  
- Сгенерируйте и вставьте `TELEGRAM_WEBHOOK_SECRET` (и при необходимости `F21_ADMIN_OPEN_SECRET`).  
- `MOYSKLAD_*` / `TBANK_*` — тестовые/placeholder, пока не подключаете боевые интеграции.

```bash
sudo chown root:www-data /etc/cvetochny21.env
sudo chmod 640 /etc/cvetochny21.env
```

---

## G. systemd

```bash
sudo cp deploy/systemd/cvet21.service.example /etc/systemd/system/cvet21.service
sudo systemctl daemon-reload
sudo systemctl enable cvet21.service
sudo systemctl restart cvet21.service
sudo systemctl status cvet21.service --no-pager
sudo journalctl -u cvet21.service -n 150 --no-pager
```

---

## H. nginx (HTTP; SSL добавит certbot)

```bash
sudo cp deploy/nginx/arhipovdan.ru.example.conf /etc/nginx/sites-available/arhipovdan.ru
sudo ln -sf /etc/nginx/sites-available/arhipovdan.ru /etc/nginx/sites-enabled/arhipovdan.ru
sudo nginx -t
sudo systemctl reload nginx
```

---

## I. SSL (certbot)

```bash
sudo certbot --nginx -d arhipovdan.ru -d www.arhipovdan.ru
sudo nginx -t
sudo systemctl reload nginx
```

---

## J. Health

```bash
curl -sS http://127.0.0.1:3000/api/health/ops | head -c 2000
curl -sS https://arhipovdan.ru/api/health/ops | head -c 2000
```

Ожидается **JSON** (не HTML витрины).

---

## K. Telegram: getMe, setWebhook, getWebhookInfo

```bash
set -a
source /etc/cvetochny21.env
set +a

curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"

curl -sS -G "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://arhipovdan.ru/api/telegram/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode "drop_pending_updates=true"

curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

---

## L. Дымовой тест тем (форум)

```bash
CHAT="-1003847910699"
for tid in 2 4 6; do
  curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT}" \
    -d "message_thread_id=${tid}" \
    -d "text=NL smoke test thread ${tid} $(date -Is)"
  echo
done
```

---

## M. Ручная проверка в Telegram

- Откройте тестового бота, команда **/start**.  
- Нажмите **«Позвать менеджера»**.  
- Смотрите логи:

```bash
sudo journalctl -u cvet21.service -f --no-pager
```

- Проверьте `getWebhookInfo`: `pending_update_count` — 0 или стабилен, не растёт бесконтрольно.

---

## См. также

- `deploy/PRODUCTION-SOURCE-OF-TRUTH-ru.md`  
- `deploy/cvetochny21.env.test-migration.example`  
- `backend/config.js` — `TELEGRAM_PROXY_URL` по умолчанию: прямой Bot API; SOCKS опционален.
