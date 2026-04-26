# Playbook Execution Light для admin panel

## Что такое playbook layer

`Playbook execution light` — это лёгкий слой исполнения поверх существующих инсайтов и action cards.
Он не строит сложную автоматизацию, а быстро подготавливает сцену для действия:
- открывает нужный экран;
- применяет нужные фильтры;
- показывает контекст сценария;
- даёт короткие next steps прямо на мобильном экране.

## Модель playbook item

Используется единый формат playbook:
- `id`
- `type`
- `title`
- `message`
- `category`
- `priority`
- `business_goal`
- `suggested_target`
- `prefilled_filters`
- `prefilled_context`
- `cta_label`
- `entry_source`
- `estimate_label` (опционально)

Модель поставляется через `GET /api/admin/playbooks/summary` и используется в frontend как application-level execution layer.

## Реализованные сценарии

1. `vip_return` — вернуть VIP-клиентов  
2. `second_order_push` — довести новых до второго заказа  
3. `frozen_revenue_recovery` — вернуть замороженную выручку  
4. `support_waiting_recovery` — разобрать клиентов без ответа  
5. `repeat_strong_campaign` — повторить сильную рассылку  
6. `lost_reach_reduction` — снизить потерянный охват  
7. `high_value_recover` — вернуть ценных клиентов с высоким чеком  
8. `post_support_retention` — удержать клиента после обращения

## Playbook Context Banner

При входе в экран через playbook показывается reusable banner:
- заголовок сценария;
- короткое объяснение;
- приоритет;
- категория;
- estimate label;
- источник запуска;
- quick steps (2–4 шага);
- CTA-группа:
  - related actions,
  - `Скрыть сценарий`,
  - `Назад к источнику`.

## Prefilled execution flow

Playbook выполняет prefilled flow:
1. Загружается playbook DTO.
2. Применяются `prefilled_filters`.
3. Сохраняется `entry_source` и `sourceScreen`.
4. Открывается `suggested_target`.
5. На экране показывается context banner с quick steps.

Результат: пользователь сразу попадает в рабочий контекст без 2–5 лишних тапов.

## Где встроены entry points

- `Главная` — блок playbook сценариев
- `Центр действий` — playbook block + кнопки `Сценарий` для части top actions/quick wins
- `Клиенты` — playbook block (retention/follow-up)
- `Заказы` — playbook block (revenue recovery)
- `Поддержка` — playbook block (support recovery)
- `Рассылки` — playbook block (campaign reuse / lost reach)
- `Карточка клиента` — CTA `Открыть сценарий`
- `Карточка рассылки` — CTA для campaign reuse / lost reach
- `Аналитика` — playbook block как execution-переход от insights

## Связь с Action Center

Action Center отвечает за приоритизацию (`что важно`), а playbook layer — за запуск (`как начать прямо сейчас`):
- часть top actions и quick wins получили кнопку `Сценарий`;
- запуск сценария сохраняет источник и ведёт в prefilled flow;
- пользователь не теряет executive контекст.

## Техническая реализация

### Backend

Добавлен endpoint:
- `GET /api/admin/playbooks/summary`

Источник данных:
- агрегаты из `clients/orders/broadcasts/support` summary.

Изменения:
- `backend/admin-repository.js` (`getPlaybooksSummary()`)
- `backend/admin-routes.js` (новый маршрут)

### Frontend

В `frontend/admin/app.js`:
- запуск playbook (`launchPlaybook`);
- playbook banner (`renderPlaybookBanner`);
- playbook quick steps;
- related CTA для сценариев;
- card-entry points в ключевых экранах;
- action handler для:
  - `launch-playbook`,
  - `playbook-dismiss`,
  - `playbook-back-source`.

В `frontend/admin/styles.css`:
- стили `playbook-banner`, `playbook-step`, `playbook-card`, `playbook-card-list`.

## Ограничения light-версии

Не реализовано (осознанно):
- automation engine;
- массовые авто-действия без подтверждений;
- playbook state machine;
- AI orchestration.

Слой execution остаётся лёгким и explainable: он ускоряет запуск правильного ручного действия, но не притворяется полной автоматизацией.
