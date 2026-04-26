# Доступ в админку

## Источник истины

Доступ основан на Telegram identity:
- используется Telegram WebApp `initData`;
- backend валидирует подпись (`hash`) и извлекает `user.id`;
- доступ разрешается только если `telegram_id` в allowlist.

## Текущий allowlist

- Primary admin: `67460775`.
- Конфиг:
  - `ADMIN_TELEGRAM_IDS` (основной),
  - `ADMIN_PRIMARY_TELEGRAM_ID` (для явного значения по умолчанию),
  - `TELEGRAM_ADMIN_IDS` (legacy fallback).

## Где стоит защита

1. **UI gate** (`frontend/app.js`)
   - кнопка `Админка` показывается только если backend `/api/admin/access` вернул `allowed=true`.

2. **Backend gate**
   - `/admin` защищён middleware-проверкой Telegram identity;
   - `/api/admin/*` защищены `requireAdmin`.

## Что запрещено

- Нет ручного login/password/token шага.
- Нет авторизации по username как primary фактору.
- Нет доступа при прямом URL без валидного Telegram контекста.

## Как добавить второго админа

1. Добавить ID в `ADMIN_TELEGRAM_IDS`.
2. Перезапустить backend.
3. Проверить видимость кнопки и доступ к `/admin`, `/api/admin/*`.

