# Диагностика деплоя и «старый интерфейс» в Telegram Mini App

Цель: понять, **какой commit реально выполняется на сервере**, что отдаётся пользователю, и не указывает ли инфраструктура на **другой каталог** или **устаревший кэш**.

Связанные файлы:

- `deploy/deploy-info.template.json` — шаблон полей (в git).
- `deploy/deploy-info.json` — **генерируется CI** перед `rsync` (в git не хранится; см. `.gitignore`).
- `frontend/deploy-info.json` — публичный маркер для браузера/WebView (в git есть значения `local`; на сервер после деплоя попадает версия от CI).

## Эндпоинты и статика

| URL | Назначение |
|-----|------------|
| `GET /api/deploy-info` | JSON: `commit`, `deployedAt`, `runId`, `cwd`, `appPublicUrl`, `frontendIndexMtime`, `frontendAppMtime`, `storefrontBuildId` и т.д. **Без секретов.** |
| `GET /deploy-info.json` | Упрощённый публичный JSON из `frontend/deploy-info.json` (удобно сверять с Actions). |

Заголовки `Cache-Control` для HTML, versioned `app.*.js`, `styles.*.css` и `deploy-info.json` на стороне Express выставлены как **no-store / no-cache** (см. `backend/server.js`). Пример принудительного перебоя заголовков на nginx — в `deploy/nginx/tgtsvetochnii21.ru.example.conf` (закомментированный блок).

## Что делает GitHub Actions

В `.github/workflows/deploy.yml`:

1. После успешного `npm test` шаг **Generate deploy info** записывает `deploy/deploy-info.json` и `frontend/deploy-info.json` с `GITHUB_SHA`, `GITHUB_RUN_ID`, UTC `deployedAt`, именем workflow.
2. После `rsync` шаг **Verify remote deploy bundle** на сервере проверяет, что в `$DEPLOY_PATH` лежит ожидаемый commit и нет устаревших строк в `frontend/index.html` / `frontend/app.js`. При ошибке job падает с текстом:  
   `Remote files do not match expected deployed commit/path.`

Важно: проверка относится к **`DEPLOY_PATH` из секрета**. Если nginx отдаёт статику **не из этого каталога**, workflow может быть зелёным, а пользователь — видеть старые файлы.

## Если после деплоя в Telegram всё ещё старый UI

1. Откройте в браузере: `https://ВАШ_ДОМЕН/api/deploy-info` — поле `commit` должно совпадать с последним успешным run в GitHub Actions (`GITHUB_SHA`).
2. Откройте `https://ВАШ_ДОМЕН/deploy-info.json` — `commit` должен совпадать с тем же SHA.
3. Сравните `commit` с **конкретным** workflow run (SHA виден в сводке или в логе шага Generate deploy info не выводится целиком — смотрите run summary / репозиторий после push).
4. На сервере:

   ```bash
   cd "$DEPLOY_PATH"
   cat frontend/deploy-info.json
   grep -R "Телефон (Введите номер с цифры 9)" frontend backend || true
   grep -R "checkout_failed_moysklad_sync" frontend || true
   ```

5. systemd:

   ```bash
   systemctl status cvet21.service
   systemctl cat cvet21.service
   ps aux | grep node
   readlink -f /proc/$(pgrep -f "backend/server.js" | head -n1)/cwd
   ```

   Убедитесь, что `WorkingDirectory` / `cwd` процесса совпадают с тем же `$DEPLOY_PATH`, куда кладёт CI артефакты.

6. nginx:

   ```bash
   sudo nginx -T | grep -E "root|alias|proxy_pass|server_name"
   ```

   По канону этого проекта Mini App и админка должны идти через **reverse proxy к Node**, без `root`/`alias` на сырой `frontend/` (см. комментарии в `deploy/nginx/tgtsvetochnii21.ru.example.conf`).

7. Проверьте URL Mini App в BotFather и переменные `APP_PUBLIC_URL` / `BASE_URL` в env сервиса — домен должен быть тем же, что вы открываете в браузере для проверки.

8. Убедитесь, что секрет **`DEPLOY_PATH`** совпадает с каталогом приложения в systemd и что nginx проксирует на тот же инстанс Node.

## Тихая диагностика на клиенте

При загрузке витрины `frontend/app.js` делает `fetch('/deploy-info.json', { cache: 'no-store' })` и пишет результат в `console.debug('[DeployInfo]', …)` — без UI для пользователя (удобно при remote debugging WebView).
