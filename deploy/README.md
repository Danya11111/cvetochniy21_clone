# Deploy artifacts (production shape из git)

**Сводный канон (маршрутизация, systemd, запрет drift):** `deploy/PRODUCTION-SOURCE-OF-TRUTH-ru.md`.

## Чеклист наличия артефактов

- [ ] `deploy/env.example` — шаблон `/etc/cvetochny21.env`
- [ ] `deploy/systemd/cvet21.service.example` — основной unit `cvet21.service`
- [ ] `deploy/systemd/admin-access.conf.example` — drop-in для admin id
- [ ] `deploy/systemd/telegram-proxy.conf.example` — drop-in для `TELEGRAM_PROXY_URL`
- [ ] `deploy/systemd/broadcast-tuning.conf.example` — drop-in для `BROADCAST_*`
- [ ] `deploy/nginx/tgtsvetochnii21.ru.example.conf` — reverse proxy на Node
- [ ] `deploy/BUILD-DELIVERY-RUNBOOK-ru.md` — HTML / build
- [ ] `deploy/PRODUCTION-RUNBOOK-ru.md` — общий pipeline
- [ ] `deploy/PRODUCTION-SOURCE-OF-TRUTH-ru.md` — единый infra-канон
- [ ] `docs/broadcast-ops-ru.md` — рассылка

Автоматическая проверка (наличие файлов, nginx routing markers, фразы в `PRODUCTION-SOURCE-OF-TRUTH`, systemd↔env.example, **env-ключи из `backend/config.js`, `backend/db.js`, server/telegram/frontend-build** присутствуют в `deploy/env.example`, битые ссылки `` `deploy/...` `` / `` `docs/...` `` в markdown):

```bash
npm run verify:manifest
```

## Имена на production

| Артефакт в git | Типичный путь на сервере |
|----------------|-------------------------|
| `cvet21.service.example` | `/etc/systemd/system/cvet21.service` |
| drop-in examples | `/etc/systemd/system/cvet21.service.d/*.conf` |
| `env.example` | `/etc/cvetochny21.env` |
| nginx example | `/etc/nginx/sites-available/…` + symlink в `sites-enabled` |

## Legacy

`deploy/systemd/cvetochny21-node.service.example` — старое имя unit; канон для production — **`cvet21.service.example`**.
