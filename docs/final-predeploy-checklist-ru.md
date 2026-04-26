# Финальный predeploy checklist (RU)

## 1) Безопасные дефолты и флаги

- В коде операционные флаги (topics/outbox/broadcasts/support/orders notify) по умолчанию **включены**; на проде проверьте фактическое состояние: `GET /api/health/ops` и лог `[Startup] F21 wiring` (подробности — `docs/production-runtime-audit-fixes-ru.md`).
- `BROADCAST_TOPIC_TEST_MODE=false` в прод-конфиге по умолчанию.
- `BROADCAST_TOPIC_TEST_TELEGRAM_IDS` пустой в проде, если test mode выключен.
- `TELEGRAM_TOPICS_ENABLED`, `BROADCASTS_ENABLED`, `SUPPORT_RELAY_ENABLED`, `ORDERS_TOPIC_NOTIFICATIONS_ENABLED`, `CLIENT_TOPIC_REPLY_ENABLED` выставлены осознанно (или подтверждены через health).
- `BROADCAST_DELETE_ENABLED` включен только если delete-for-all нужен операционно.
- `TELEGRAM_WEBHOOK_SECRET` установлен и совпадает в Telegram webhook.

## 2) Admin panel (mobile)

- Все ключевые экраны открываются без layout-ломок:
  - Главная, Действия, Заказы, Клиенты, Карточка клиента, Рассылки, Карточка рассылки, Поддержка, Аналитика.
- Длинные подписи/username/суммы не ломают карточки.
- Sticky action bar не конфликтует с bottom nav на узком экране.
- Empty/calm/error состояния читаемы и не техничны.

## 3) Confirmation safety

- `Удалить у всех` всегда через destructive confirmation sheet.
- `Сохранить флаги` через high-impact confirmation sheet.
- `Outbox reprocess` через normal confirmation.
- High-impact playbook entry points (`repeat_strong_campaign`, `lost_reach_reduction`) требуют явного confirm.
- Double tap не запускает повторный submit (in-flight guard + loading кнопка).

## 4) Telegram topic flows

- Тема Заказы:
  - новый заказ -> уведомление в orders topic;
  - есть кнопка перехода в тему клиента;
  - в тему клиента приходит карточка заказа.
- Тема Поддержка:
  - сообщение клиента -> уведомление в support topic;
  - диалог дублируется в личную тему клиента;
  - ответ менеджера из темы клиента уходит клиенту.
- Тема Рассылки:
  - сообщение в broadcast topic запускает broadcast flow;
  - summary приходит в ту же тему;
  - delete-for-all работает и пишет итог.
- Личные темы клиентов:
  - `ensureClientTopic` стабильно создаёт/находит тему;
  - переходы в тему клиента из admin работают.

## 5) Broadcast topic test mode

- При `BROADCAST_TOPIC_TEST_MODE=true` рассылка через тему уходит **только** на allowlist.
- Если allowlist пустой — рассылка не отправляется никому (fail closed), в тему приходит понятное сообщение.
- Summary в test mode явно помечается как тестовый.
- При `BROADCAST_TOPIC_TEST_MODE=false` работает обычная аудитория.

## 6) Бэкенд и запуск

- Проверка синтаксиса изменённых файлов (`node --check`) проходит.
- Нет свежих lints в изменённых файлах.
- Вебхук Telegram отвечает `ok: true` на валидные апдейты.
- Не появились незапланированные destructive paths без confirm.

## 7) Финальный smoke-run перед деплоем

1. Отправить тестовое сообщение в тему рассылки при test mode ON и 1-2 ID в allowlist.
2. Проверить summary с пометкой test mode.
3. Выключить test mode.
4. Проверить, что обычный topic broadcast использует штатную аудиторию.
5. Из админки выполнить `Удалить у всех` с confirm sheet.
6. Проверить Action Center + playbook + возвраты контекста.

## 8) Критерий go/no-go

Go:
- topic flows целы;
- test mode безопасен;
- mass actions защищены;
- mobile UI стабилен.

No-go:
- рассылка может уйти шире allowlist при test mode;
- delete-for-all запускается без confirm;
- broken topic routing;
- критичные визуальные/UX регрессии на мобильном.
