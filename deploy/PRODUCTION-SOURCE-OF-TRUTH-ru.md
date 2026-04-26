# Production: источник правды (git → сервер)

Короткий канон: **что считать эталоном**, куда смотреть при деплое и диагностике. Детали — в `deploy/PRODUCTION-RUNBOOK-ru.md`, `deploy/BUILD-DELIVERY-RUNBOOK-ru.md`, `docs/broadcast-ops-ru.md`.

## 1. Что нельзя считать источником правды на сервере

- Ручные правки **`frontend/index.html`**, **`frontend/admin/index.html`** в обход деплоя (плейсхолдер **`__F21_BUILD__`** должен подставляться только через **`injectHtmlBuildStamp`** на Node).
- «Эталонный» nginx/systemd/env **только** в `/etc/…` без соответствия файлам из **git** (drift: после сбоя или смены админа никто не воспроизведёт схему).
- Раздача storefront/admin HTML **напрямую с диска** через nginx `root`/`alias` на каталог `frontend/` — клиент получит шаблон без build inject и сломается сопоставление с `/app.<build>.js` / `/styles.<build>.css`.

Исторически drift возникал из сочетания: правки в `sites-enabled`, частичные drop-ins, ручные SQL hotfix (для БД это закрыто кодом миграций; для nginx/systemd — этим документом и `npm run verify:manifest`).

## 2. Канонические файлы в репозитории

| Область | Файлы-эталон |
|--------|----------------|
| Env (шаблон под `/etc/cvetochny21.env`) | `deploy/env.example` |
| systemd unit | `deploy/systemd/cvet21.service.example` → на сервере `cvet21.service` |
| Drop-ins | `deploy/systemd/admin-access.conf.example`, `deploy/systemd/telegram-proxy.conf.example`, `deploy/systemd/broadcast-tuning.conf.example` |
| Опционально: SOCKS-туннель | `deploy/systemd/ssh-tg-socks.service.example` |
| nginx vhost | `deploy/nginx/tgtsvetochnii21.ru.example.conf` |
| HTML / build id | `deploy/BUILD-DELIVERY-RUNBOOK-ru.md` + `backend/frontend-build-id.js` |
| Рассылка / health | `docs/broadcast-ops-ru.md` |

**Legacy (не использовать как имя основного unit):** `deploy/systemd/cvetochny21-node.service.example` — старое имя; канон **`cvet21.service.example`**.

## 3. Канонический production routing (HTTP → Node)

Весь публичный HTTPS-трафик домена приложения **reverse proxy на один upstream Node** (см. `deploy/nginx/tgtsvetochnii21.ru.example.conf`). **Не** отдавать HTML магазина/админки статикой из nginx.

| Путь / паттерн | Кто отвечает | Примечание |
|----------------|--------------|------------|
| `/`, `/index.html` | Node | Storefront SPA после inject build |
| `/app.<build>.js`, `/styles.<build>.css` | Node | Versioned assets |
| `/admin-launch` | Node | POST handoff |
| `/admin-embed`, `/admin` | Node | Admin UI (флаги `ADMIN_*` в config) |
| `/admin-assets/` | Node | Статика админки |
| `/api/*` | Node | JSON API, в т.ч. **`GET /api/health/ops`** (диагностика: broadcast, transport, `broadcastOps`, …) |

Проверка после деплоя: **`GET /api/health/ops`** должен возвращать JSON (не HTML витрины).

## 4. Каноническая модель systemd + env

- **Unit:** `cvet21.service` из `deploy/systemd/cvet21.service.example`.
- **Один основной EnvironmentFile:** `EnvironmentFile=-/etc/cvetochny21.env` (шаблон — `deploy/env.example`).
- **Drop-ins** в `cvet21.service.d/*.conf` — только точечные override (admin ids, `TELEGRAM_PROXY_URL`, `BROADCAST_*`), без дублирования всего env без причины.
- **Рабочий каталог:** `WorkingDirectory` в unit должен указывать на корень репозитория с `backend/server.js`.

Ключи окружения (смысл и обязательность): см. комментарии в **`deploy/env.example`**. Критичные группы:

- **Admin / доступ:** `ADMIN_TELEGRAM_IDS` (union с дефолтами в коде), `TELEGRAM_ADMIN_IDS` (отдельный CSV; **только он** — allowlist триггера рассылки из темы в `broadcast-service`), **`F21_ADMIN_OPEN_SECRET`** (в production ожидается **не короче 32 символов**; иначе в логах `[AdminOpenToken] ... using derived key`), `ADMIN_PRIMARY_TELEGRAM_ID`.
- **Telegram transport:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED`, **`TELEGRAM_PROXY_URL`** (по умолчанию в коде — прямой Bot API; для RU с SOCKS задайте `socks5h://...` — см. `backend/config.js`), `TELEGRAM_BOT_USERNAME`.
- **Broadcast:** все **`BROADCAST_*`**, темы **`TELEGRAM_BROADCAST_*`**, probe **`TELEGRAM_TRANSPORT_PROBE_*`**, auto-resume **`BROADCAST_PAUSED_*`** — см. `docs/broadcast-ops-ru.md`.
- **Build / runtime:** `F21_FRONTEND_BUILD` (опционально), `PORT`, `BASE_URL`; БД: опционально **`F21_SQLITE_PATH`** (иначе путь по умолчанию рядом с приложением).

## 5. Чистый deploy path (без ручного «творчества»)

1. `git pull` в каталог деплоя (тот же путь, что в `WorkingDirectory` unit).
2. При необходимости `npm install --omit=dev` (как принято в вашем pipeline).
3. Свести `/etc/cvetochny21.env` и nginx/systemd с шаблонами из **git** (не копировать вслепую — сравнить diff).
4. `sudo systemctl daemon-reload && sudo systemctl restart cvet21.service`
5. Проверить **`GET /api/health/ops`**, логи `[F21HtmlBuildInject]` при первом запросе HTML.

Автоматическая проверка согласованности шаблонов: **`npm run verify:manifest`**.
