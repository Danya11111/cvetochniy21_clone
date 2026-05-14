# Скрипты миграции SQLite (RU → новый сервер)

Скрипты рассчитаны на **bash** и **sqlite3** CLI (Debian/Ubuntu: `apt install sqlite3`).  
**Не подключаются к production** сами по себе — оператор указывает пути к файлам на своей машине.

## Безопасность

- Резервные копии пишутся в каталог **`backups/`** в корне репозитория (или в `BACKUP_DIR`) — каталог **в `.gitignore`**, не коммитить.
- **`restore.sh`** откажется работать без `CONFIRM_RESTORE=yes`.
- Перед **`restore`** и **`backup`** в идеале **останавливайте** процесс Node, использующий эту БД, иначе возможны гонки с `-wal`.

## Переменные окружения

| Переменная | Назначение |
|------------|------------|
| `F21_SQLITE_PATH` | Путь к живой БД (как в `backend/db.js`) |
| `SQLITE_SOURCE` | Явный путь источника для `backup.sh` (перекрывает дефолт) |
| `BACKUP_DIR` | Куда складывать `.backup` (по умолчанию `REPO_ROOT/backups`) |
| `SQLITE_RESTORE_SOURCE` | Файл бэкапа для `restore.sh` |
| `SQLITE_DB_PATH` | **Абсолютный** путь целевой БД для `restore.sh` / `validate.sh` |
| `CONFIRM_RESTORE` | Должно быть `yes` для `restore.sh` |

## Команды

Из корня репозитория:

```bash
chmod +x scripts/migration/*.sh

# Бэкап (укажите путь к production-файлу)
F21_SQLITE_PATH=/var/lib/cvetochny21/app.sqlite ./scripts/migration/backup.sh

# Проверка любого файла БД
SQLITE_DB_PATH=/path/to/f21-db-....sqlite ./scripts/migration/validate.sh

# Восстановление (приложение остановлено!)
CONFIRM_RESTORE=yes \
  SQLITE_DB_PATH=/var/lib/cvetochny21/app.sqlite \
  SQLITE_RESTORE_SOURCE=/safe/f21-db-....sqlite \
  ./scripts/migration/restore.sh
```

## Файлы вне SQLite

Обязательно переносите каталог **`backend/data/promotion-uploads/`** тем же переносом, что и БД:

```bash
rsync -aH --progress /old/app/backend/data/promotion-uploads/ user@new:/new/app/backend/data/promotion-uploads/
```

Пути к загруженным файлам сохранены в таблицах `promotion_broadcasts` и `promotion_broadcast_images`.

## NPM-алиасы

В `package.json` добавлены удобные вызовы `npm run db:migration:*` (под тем же Bash; на чистой Windows без Git Bash они могут быть недоступны).

Подробный сценарий cutover см. **`docs/database-migration-ru-to-new-server.md`**.
