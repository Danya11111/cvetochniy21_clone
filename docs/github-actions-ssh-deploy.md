# GitHub Actions: CI и деплой по SSH

Этот документ описывает workflow `.github/workflows/deploy.yml`: проверка кода на раннере GitHub, доставка репозитория на сервер через `rsync` по SSH, установка production-зависимостей и перезапуск процесса через **systemd** или **pm2**.

Связанные материалы:

- Перенос SQLite и данных: [database-migration-ru-to-new-server.md](./database-migration-ru-to-new-server.md)
- Смоук-тест после выката: [production-smoke-test-checklist.md](./production-smoke-test-checklist.md)
- Примеры systemd в репозитории: `deploy/systemd/cvet21.service.example`, `deploy/cvetochniy21.service.example`

## A. Что делает CI/CD

1. **CI (ubuntu-latest)**  
   - `actions/checkout`, `actions/setup-node` (Node 20, кэш npm).  
   - Зависимости: `npm ci`, если в корне есть `package-lock.json`, иначе `npm install`.  
   - `npm test` (в этом проекте в `npm test` уже входит `npm run verify:manifest`, отдельный шаг не дублируется).  
   - Отдельных скриптов `lint`, `typecheck`, `build` в `package.json` нет — в workflow они не добавляются.

2. **SSH**  
   - В `~/.ssh/deploy_key` записывается секрет `DEPLOY_SSH_KEY` (права `600`), host key добавляется через `ssh-keyscan -p PORT HOST` в `known_hosts`.  
   - **StrictHostKeyChecking=yes** (без `StrictHostKeyChecking=no`).

3. **Сервер**  
   - `mkdir -p "$DEPLOY_PATH"` и проверка, что каталог доступен на запись от имени `DEPLOY_USER`.  
   - Production `.env` workflow **не создаёт и не изменяет**.

4. **Деплой**  
   - `rsync -avz` по SSH **без `--delete`**, чтобы не сносить на сервере файлы, которых нет в репозитории (в т.ч. SQLite, uploads, локальный `.env`).

5. **После копирования**  
   - В `$DEPLOY_PATH`: `npm ci --omit=dev` при наличии `package-lock.json`, иначе `npm install --omit=dev`.  
   - Перезапуск см. раздел ниже.

6. **Healthcheck (мягкий)**  
   - Скрипт `scripts/gha-remote-healthcheck-soft.sh`: если есть `curl` и в `.env` найден `APP_PUBLIC_URL` или `BASE_URL`, выполняется запрос к `${URL}/api/health/ops`, затем при неуспехе к `${URL}/health`.  
   - Реальный публичный JSON-эндпоинт в приложении: **`GET /api/health/ops`** (см. `backend/server.js`).  
   - Ошибка healthcheck **не валит** workflow — только сообщение в лог.

Логика установки и перезапуска на сервере вынесена в:

- `scripts/gha-remote-post-rsync.sh`
- `scripts/gha-remote-healthcheck-soft.sh`

## B. Repository Secrets (только эти пять)

| Secret           | Назначение                          |
|------------------|-------------------------------------|
| `DEPLOY_HOST`    | IP или hostname сервера             |
| `DEPLOY_USER`    | SSH-пользователь                    |
| `DEPLOY_PORT`    | Порт SSH (часто `22`)             |
| `DEPLOY_PATH`    | Абсолютный путь к корню приложения на сервере |
| `DEPLOY_SSH_KEY` | Приватный ключ OpenSSH (содержимое целиком) |

Другие секреты (known_hosts отдельным secret, URL healthcheck, команда рестарта) **не используются**.

## C. Публичный ключ на сервере (вручную)

1. На своей машине откройте файл публичного ключа, например `~/.ssh/id_ed25519.pub`.
2. Скопируйте одну строку вида `ssh-ed25519 AAAA... comment`.
3. На сервере под административным пользователем добавьте строку в `~/.ssh/authorized_keys` того пользователя, от которого идёт деплой (значение `DEPLOY_USER`):

   ```bash
   mkdir -p ~/.ssh
   chmod 700 ~/.ssh
   echo 'ssh-ed25519 AAAA... ваш-ключ' >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ```

4. Проверка входа с ноутбука:

   ```bash
   ssh -i ~/.ssh/id_ed25519 -p ПОРТ USER@SERVER_IP
   ```

В GitHub кладётся **приватный** ключ, парный к этому публичному (`DEPLOY_SSH_KEY`).

## D. Как добавить secrets в GitHub

Репозиторий → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.  
Создайте пять переменных из таблицы выше. Имена должны совпадать с указанными (в т.ч. регистр).

## E. Что должно быть на сервере до первого деплоя

- Установлены **Node.js** и **npm** (версия Node ≥ 18, см. `package.json` → `engines`).
- Существует каталог `DEPLOY_PATH`, пользователь `DEPLOY_USER` может в него **писать**.
- В корне деплоя лежит **production `.env`** (создаётся вручную, не из GitHub Actions).
- **`F21_SQLITE_PATH`** указывает на постоянный файл SQLite вне зоны перезаписи rsync (или на путь, явно исключённый из синхронизации; по умолчанию файл в репо — `backend/database.sqlite` — в rsync **исключён**, чтобы не затереть прод).
- Файл БД и каталог **`backend/data/promotion-uploads/`** перенесены по [playbook миграции](./database-migration-ru-to-new-server.md), если это новый сервер.
- Настроен один из вариантов управления процессом (см. workflow):

  - systemd-unit **`cvetochniy21.service`** или **`f21.service`**, **или**
  - процесс **pm2** с именем **`cvetochniy21`** или **`f21`**.

Если у вас уже используется канонический пример **`cvet21.service`** из `deploy/systemd/cvet21.service.example`, workflow его **не перезапускает**. Варианты: установить дополнительный unit с именем `cvetochniy21.service`, symlink, либо использовать **pm2** с именем из списка выше.

Для **systemd**: пользователь `DEPLOY_USER` должен иметь возможность выполнять `sudo systemctl restart …` **без интерактивного пароля**, если рестарт идёт через `sudo` (см. раздел G).

## F. Пример systemd unit

Пример с корректным `Environment=NODE_ENV=production` (отдельной строки `NODE_ENV=...` в секции `[Service]` в unit-файле быть не должно):

Пример в репозитории: [deploy/cvetochniy21.service.example](../deploy/cvetochniy21.service.example).

Кратко:

```ini
[Unit]
Description=Cvetochniy21 backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/var/www/cvetochniy21
Environment=NODE_ENV=production
EnvironmentFile=/var/www/cvetochniy21/.env
User=deploy
Group=deploy
ExecStart=/usr/bin/node backend/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Установка на сервере — вручную (`cp` в `/etc/systemd/system/`, `daemon-reload`, `enable --now`). CI **не** устанавливает unit.

## G. Пример sudoers для restart (вручную, без автоприменения)

Ограниченный NOPASSWD только для конкретных команд:

```text
deploy ALL=NOPASSWD: /bin/systemctl restart cvetochniy21.service, /bin/systemctl status cvetochniy21.service
```

Файл в `/etc/sudoers.d/` создаётся только вручную администратором (`visudo`). Workflow этот файл **не трогает**.

## H. Чего workflow намеренно не делает

- Не копирует и не мигрирует **SQLite** с раннера на сервер.
- Не трогает **`backend/data/promotion-uploads/`** на сервере (каталог в списке исключений rsync).
- Не создаёт и не обновляет production **`.env`**.
- Не меняет секреты **Telegram / Т-Банк / МойСклад** (они в `.env` на сервере).
- Не запускает две writable-копии SQLite и не выполняет разрушающие миграции.

## I. Первый деплой (чеклист)

1. Подготовить сервер: Node, npm, каталог `DEPLOY_PATH`, права пользователя.
2. Добавить **публичный** ключ в `~/.ssh/authorized_keys` для `DEPLOY_USER`.
3. Проверить вход по SSH без пароля с той же машины/ключа, что будет в `DEPLOY_SSH_KEY`.
4. Перенести SQLite по [database-migration-ru-to-new-server.md](./database-migration-ru-to-new-server.md).
5. Перенести **`backend/data/promotion-uploads/`**.
6. Создать на сервере production **`.env`** (включая `APP_PUBLIC_URL` или `BASE_URL`, `F21_SQLITE_PATH`, ключи интеграций).
7. Настроить **systemd** (`cvetochniy21.service` / `f21.service` или согласовать имя с разделом E) **или** **pm2** (`cvetochniy21` / `f21`).
8. Добавить в GitHub пять Repository Secrets.
9. Запустить workflow вручную: **Actions** → **Deploy via SSH** → **Run workflow**, либо сделать push в `main`.
10. Проверить логи job, работу сайта, checkout, админку, Telegram, Т-Банк ([production-smoke-test-checklist.md](./production-smoke-test-checklist.md)).

## Исключения rsync (кратко)

Не синхронизируются (среди прочего): `.git/`, `.github/`, `node_modules/`, `.env`, маски `.env.*` (с явным **включением** `.env.example` из репозитория), файлы SQLite и других БД, `backups/`, дампы, `backend/data/promotion-uploads/`, `logs/`, `*.log`. Режим **без `--delete`**.

## Безопасность

- В репозитории должны встречаться только **имена** секретов; строки `DEPLOY_SSH_KEY` в workflow — это ссылки на GitHub Secrets, не содержимое ключа.
- Не коммитьте `BEGIN OPENSSH PRIVATE KEY`, `BEGIN RSA PRIVATE KEY`, `BEGIN PRIVATE KEY`, реальный `.env`, `database.sqlite`, каталог `backups/`.
