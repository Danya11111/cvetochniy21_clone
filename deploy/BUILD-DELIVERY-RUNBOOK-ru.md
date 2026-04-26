# Build delivery: HTML и versioned assets

## Источник правды

- Файлы `frontend/index.html` и `frontend/admin/index.html` в **git** содержат только плейсхолдер **`__F21_BUILD__`** (в т.ч. в строке `window.__F21_BUILD__ = '__F21_BUILD__';`).
- **Не редактировать** эти HTML на сервере вручную и не подменять плейсхолдер на `__F21_BUILD_VALUE__` или на конкретный build id.
- В production HTML для витрины и админки отдаёт **Node** (`backend/server.js`) после **`injectHtmlBuildStamp`** — подстановка build id и валидация выполняются в `backend/frontend-build-id.js`.

## Nginx

- Используйте reverse proxy на процесс Node (см. `deploy/nginx/tgtsvetochnii21.ru.example.conf`).
- **Не** настраивайте `root` / `alias` на каталог `frontend/` для раздачи `index.html` магазина или админки: иначе клиент получит **сырой** шаблон без подстановки build id и возможен рассинхрон с versioned URL (`/app.<build>.js` и т.д.).
- Логи с тегом `[F21HtmlBuildInject]` в journalctl помогают подтвердить успешную инжекцию.

## Деплой

1. Обновить код из git, перезапустить Node (по вашему процессу: systemd и т.д.).
2. Убедиться, что активный nginx-конфиг соответствует шаблону (proxy на Node, без статической раздачи HTML из дерева репозитория на диске сервера как замены ответа приложения).

## systemd / env

Кратко: переменная `F21_FRONTEND_BUILD` (если задана) задаёт явный build id; иначе используется разрешение из `frontend-build-id.js` (git SHA, `frontend/BUILD_ID`, fallback). Подробности — в `backend/frontend-build-id.js`. Канонический unit: `deploy/systemd/cvet21.service.example` и `EnvironmentFile=-/etc/cvetochny21.env` (см. `deploy/PRODUCTION-SOURCE-OF-TRUTH-ru.md`). Файл `deploy/systemd/cvetochny21-node.service.example` — **legacy**, только для справки.
