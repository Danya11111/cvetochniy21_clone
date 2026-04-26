# Архитектура проекта

## Кратко

«Цветочный 21» — монолитный Node.js backend + Telegram WebApp frontend.  
Проект покрывает оформление заказов, оплату, синхронизацию с МойСклад, Telegram operational-потоки и админский контур.

## Технологический стек

- Backend: Node.js (CommonJS), `express`, `sqlite3`, `axios`, `crypto`, `cors`.
- Frontend: vanilla JS/HTML/CSS.
- База данных: SQLite (`backend/database.sqlite`).
- Платежи: T-Bank API.
- ERP/учёт: МойСклад API.
- Telegram: Bot API + WebApp.

## Логические контуры

1. **Клиентский контур (WebApp)**  
   Каталог, корзина, оформление заказа, профиль, история заказов.

2. **Платежный контур**  
   Checkout -> T-Bank init -> webhook notify -> фиксация статуса и post-paid side effects.

3. **Telegram operational контур**  
   Topics registry, outbox worker, broadcasts, support relay, order topic notifications.

4. **Admin контур**  
   Backend admin API + отдельный `frontend/admin` mini-SPA.

## Основные точки входа

- `backend/server.js` — основной backend entrypoint.
- `frontend/index.html` + `frontend/app.js` — WebApp.
- `frontend/admin/index.html` + `frontend/admin/app.js` — админка.

## Структура модулей backend (ключевое)

- `db.js` — инициализация схемы и runtime-расширения.
- `tbank.js` — платежные операции и webhook-обработка.
- `moysklad.js` — каталог/заказы/статусы в МойСклад.
- `event-publisher.js` — внутренний event-слой публикации (без внешнего Sambot target).
- `telegram-client.js` — адаптер Telegram API.
- `telegram-routing-service.js` — маршрутизация/регистрация тем.
- `outbox-repository.js`, `outbox-worker.js` — reliable delivery.
- `broadcast-service.js`, `support-service.js`, `order-topic-notification-service.js`.
- `admin-auth.js`, `admin-routes.js`, `admin-repository.js`, `runtime-flags-service.js`.

## Конфигурация

Центрально в `backend/config.js`:
- интеграционные ключи и URL;
- feature flags Stage1/Stage2;
- admin allowlist параметры.

## Ключевые архитектурные свойства

- Монолитный процесс (API + фоновые задачи в одном runtime).
- Поведение фич управляется feature flags.
- Идемпотентность критичных side-effects реализована на уровне БД и outbox.
- Внутренние operational-доставки изолированы от платежного источника истины.

## Ограничения/риски

- Outbox worker in-process (для multi-instance потребуется отдельная coordination-стратегия).
- Часть конфигурации/флагов требует рестарта backend для полного эффекта.
- Внешняя Sambot-зависимость удалена; operational-потоки полностью внутренние.

