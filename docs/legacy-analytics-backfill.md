# Legacy analytics backfill после переноса SQLite

После переноса старой базы на новый сервер новые колонки аналитики (`users.first_seen_at`, источники в профиле, denorm-поля `support_threads`) могут быть пустыми или содержать ошибочные массовые значения (например «дата миграции» у всех пользователей без заказов). Это не ломает оплату/Т‑Банк/МойСклад, но искажает админ‑дашборд.

## Что уже исправлено без ручного backfill

Серверная аналитика использует устойчивые SQL‑выражения:

- **Новые клиенты**: «эффективная» дата первого появления = `COALESCE(first_seen_at, created_at, первый заказ, первое сообщение поддержки, создание треда поддержки)` — без подстановки «сегодня» для всех подряд.
- **Источники**: bucket новых клиентов учитывает `first_source_code` / `last_source_code`, а если в профиле пусто — **`source_code` первого заказа**. Если данных нет, это отображается как **«Не определено»**, отдельно считаются `sourcesAnalytics.sourceKnownCount/sourceUnknownCount`.
- **Скорость ответа**: если таблица `support_response_windows` пуста после импорта, берётся среднее по парам сообщений **CLIENT_TO_TOPIC → следующий TOPIC_TO_CLIENT (SENT)**. Если пар нет, метка **«Недостаточно данных»** — это ожидаемо, не ошибка.

## Что делает maintenance‑скрипт (точечное восстановление в БД)

Файл: `scripts/maintenance/backfill-legacy-analytics.js`  
Логика SQL вынесена в `backend/legacy-analytics-maintenance.js` (без импорта `backend/db.js`).

Идемпотентно:

- **users.first_seen_at**: заполняет пустые значения цепочкой `created_at → заказы → поддержка → треды`; дополнительно пытается снять «ядовитый» доминирующий кластер одинаковых `first_seen_at` (эвристика: очень большая доля пользователей с одним и тем же значением).
- **Источники в профиле**: заполняет только пустые `first_source_code/last_source_code` из заказов и `promotion_source_clicks` (если таблицы есть).
- **support_threads denorm**: вызывает `reconcileSupportThreadsDenormFromMessages` из `backend/support-threads-schema.js`.

Скрипт **не удаляет строки**, не делает `DROP`/`DELETE`, не перетирает непустые корректные значения источников.

## Ограничения (что нельзя честно восстановить)

Если в legacy‑данных не было трекинга UTM/источников и нет `orders.source_code`, то:

- источник **нельзя вывести из воздуха** — это будет bucket **`__none__` / «Не определено»**;
- это **не поломка**, а отражение отсутствия данных.

## Запуск dry-run

Из корня репозитория:

```bash
node scripts/maintenance/backfill-legacy-analytics.js --db="C:\\path\\to\\database.sqlite"
```

или:

```bash
set F21_SQLITE_PATH=C:\\path\\to\\database.sqlite
node scripts/maintenance/backfill-legacy-analytics.js
```

Вывод: JSON‑summary без персональных данных (агрегаты/счётчики).

## Запуск apply

Требуется явное подтверждение:

```bash
set CONFIRM_BACKFILL_LEGACY_ANALYTICS=yes
node scripts/maintenance/backfill-legacy-analytics.js --db="C:\\path\\to\\database.sqlite" --apply
```

## Быстрая проверка после apply

- Дашборд: «Новые клиенты» не должны совпадать с числом всех пользователей только из‑за даты миграции.
- Дашборд: «Лучшие источники» не должны показывать `undefined`.
- Поддержка: у активных тредов должны быть заполнены `last_client_message_at` / `last_staff_reply_at` там, где есть исторические сообщения.

npm‑алиас:

```bash
npm run maintenance:backfill-legacy-analytics -- --db="C:\\path\\to\\database.sqlite"
```
