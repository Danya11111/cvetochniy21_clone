# Админ-панель

## Назначение

Admin mini-SPA и backend admin API обеспечивают операционную видимость и управление:
- рассылками,
- поддержкой,
- заказами,
- клиентами/темами,
- outbox/health/флагами/аудитом.

## Реализация

- Frontend: `frontend/admin/index.html`, `frontend/admin/app.js`, `frontend/admin/styles.css`.
- Backend: `backend/admin-routes.js` + `backend/admin-*` модули.

## Основные разделы UI (mobile-first foundation)

- Нижняя навигация: `Главная`, `Заказы`, `Клиенты`, `Рассылки`, `Ещё`
- `Ещё`: `Поддержка`, `Аналитика`, `Темы клиентов`, `Система`
- `Главная`: hero KPI, сравнение, блок `Требует внимания`, `Потери`, `Быстрые действия`, `Инсайт дня`
- `Система`: служебные разделы (health, outbox, flags, audit) на втором уровне IA

## Основные admin API

- `/api/admin/config`
- `/api/admin/dashboard`
- `/api/admin/mobile-summary`
- `/api/admin/broadcasts*`
- `/api/admin/support/threads*`
- `/api/admin/orders*`
- `/api/admin/orders/summary`
- `/api/admin/clients*`
- `/api/admin/topics`
- `/api/admin/outbox`
- `/api/admin/feature-flags`
- `/api/admin/audit-log`
- `/api/admin/health`

## Принципы

- Изоляция от клиентского WebApp.
- Явная permission-модель на backend.
- Операционные действия логируются в `admin_action_logs`.

