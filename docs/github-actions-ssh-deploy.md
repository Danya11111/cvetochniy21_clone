# GitHub Actions: CI и деплой по SSH

Этот документ описывает workflow `.github/workflows/deploy.yml`: проверка кода на раннере GitHub, доставка репозитория на сервер через `rsync` по SSH, установка production-зависимостей и перезапуск процесса через **systemd** или **pm2**.

Связанные материалы:

- Перенос SQLite и данных: [database-migration-ru-to-new-server.md](./database-migration-ru-to-new-server.md)
- Смоук-тест после выката: [production-smoke-test-checklist.md](./production-smoke-test-checklist.md)
- Примеры systemd в репозитории: **`deploy/systemd/cvet21.service.example`** (рекомендуемый для production, см. `deploy/PRODUCTION-SOURCE-OF-TRUTH-ru.md`) и **`deploy/cvetochniy21.service.example`** (дополнительный пример с именем unit под GitHub Actions). Оба файла остаются в репозитории.

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
   - Перезапуск: `scripts/gha-remote-post-rsync.sh` вызывает **`systemctl restart`** или **`pm2 restart`** в таком порядке:
     1. `cvetochniy21.service`
     2. `cvet21.service`
     3. `f21.service`
     4. pm2 **`cvetochniy21`**
     5. pm2 **`cvet21`**
     6. pm2 **`f21`**

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

## Ошибка `mkdir: missing operand` в GitHub Actions

Если на шаге подготовки каталога на сервере появляется:

```text
mkdir: missing operand
Try 'mkdir --help' for more information.
```

это почти всегда значит, что **`DEPLOY_PATH` пустой или не попал в remote shell** (например, секрет не задан, опечатка в имени `DEPLOY_PATH`, или путь раньше «терялся» из‑за кавычек в `ssh bash -lc`).

**Что сделать:**

1. Репозиторий → **Settings** → **Secrets and variables** → **Actions** → проверьте, что задан **`DEPLOY_PATH`** и имя совпадает с тем, что ожидает workflow.
2. Значение должно быть **абсолютным путём**, без пробелов по краям, например `/var/www/cvetochniy21` или `/opt/cvetochny21_tg`.
3. Нельзя оставлять `DEPLOY_PATH` **пустым** и нельзя указывать только **`/`** (корень ФС).
4. После исправления секрета снова запустите workflow (**push в `main`** или **Actions → Deploy via SSH → Run workflow**).

Текущий workflow перед деплоем выполняет шаг **Validate deploy secrets**: при пустом или некорректном `DEPLOY_PATH` job завершится с **понятным сообщением** ещё до `mkdir`/`rsync`.

## Проверка secrets без раскрытия значений

В `.github/workflows/deploy.yml` шаг **Validate deploy secrets**:

- проверяет, что все пять переменных **заданы и непустые**;
- проверяет, что `DEPLOY_PORT` — **целое число**;
- проверяет, что `DEPLOY_PATH` **начинается с `/`** и **не равен** `/`;
- проверяет форму приватного ключа (`BEGIN` и `PRIVATE KEY` в содержимом), **без вывода ключа в лог**;

Сами значения секретов GitHub обычно **маскирует** в логах; в скрипте валидации намеренно **нет** `echo` путей, паролей и ключа.

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
- Настроен один из вариантов управления процессом, **имя на сервере должно совпадать** с тем, что ищет деплой:
  - **systemd:** `cvetochniy21.service`, **`cvet21.service`** (типичный путь: скопировать `deploy/systemd/cvet21.service.example` в `/etc/systemd/system/cvet21.service`) или `f21.service`;
  - **pm2:** процесс `cvetochniy21`, **`cvet21`** или `f21`.

Если вы ставите unit по **`deploy/systemd/cvet21.service.example`**, на сервере файл должен называться **`cvet21.service`** (так же указано в комментариях примера). Проверка и перезапуск вручную:

```bash
systemctl status cvet21.service
sudo systemctl restart cvet21.service
```

Для **systemd**: пользователь `DEPLOY_USER` должен иметь возможность выполнять `sudo systemctl restart …` **без интерактивного пароля**, если рестарт идёт через `sudo` (см. раздел G).

## F. Пример systemd unit

**Рекомендуемый канонический пример** в этом репозитории — `deploy/systemd/cvet21.service.example` (переменные через `EnvironmentFile`, пользователь `www-data`, пути из вашего runbook). Дополнительно есть `deploy/cvetochniy21.service.example` (короткий шаблон под имя `cvetochniy21.service`), если удобнее держать unit с таким именем; workflow поддерживает **оба** имени unit (и `cvet21`, и `cvetochniy21`).

Пример с корректным `Environment=NODE_ENV=production` (отдельной строки `NODE_ENV=...` в секции `[Service]` в unit-файле быть не должно). Ниже — упрощённый фрагмент в духе `deploy/cvetochniy21.service.example`:

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
deploy ALL=NOPASSWD: /bin/systemctl restart cvetochniy21.service, /bin/systemctl status cvetochniy21.service, /bin/systemctl restart cvet21.service, /bin/systemctl status cvet21.service
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
7. Настроить **systemd** (`cvetochniy21.service` / **`cvet21.service`** / `f21.service`, см. раздел E) **или** **pm2** (`cvetochniy21` / **`cvet21`** / `f21`).
8. Добавить в GitHub пять Repository Secrets.
9. Запустить workflow вручную: **Actions** → **Deploy via SSH** → **Run workflow**, либо сделать push в `main`.
10. Проверить логи job, работу сайта, checkout, админку, Telegram, Т-Банк ([production-smoke-test-checklist.md](./production-smoke-test-checklist.md)).

## Исключения rsync (кратко)

Не синхронизируются (среди прочего): `.git/`, `.github/`, `node_modules/`, `.env`, маски `.env.*` (с явным **включением** `.env.example` из репозитория), файлы SQLite и других БД, `backups/`, дампы, `backend/data/promotion-uploads/`, `logs/`, `*.log`. Режим **без `--delete`**.

## Безопасность

- В репозитории должны встречаться только **имена** секретов; строки `DEPLOY_SSH_KEY` в workflow — это ссылки на GitHub Secrets, не содержимое ключа.
- Не коммитьте `BEGIN OPENSSH PRIVATE KEY`, `BEGIN RSA PRIVATE KEY`, `BEGIN PRIVATE KEY`, реальный `.env`, `database.sqlite`, каталог `backups/`.
