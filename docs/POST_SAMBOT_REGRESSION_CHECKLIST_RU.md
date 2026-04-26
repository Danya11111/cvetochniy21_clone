# POST_SAMBOT_REGRESSION_CHECKLIST_RU

## 1) Checkout / Payment smoke

1. Сделать новый checkout через WebApp.
2. Убедиться, что:
   - создан заказ в `orders`,
   - получен `paymentUrl`.
3. Провести оплату.
4. Проверить:
   - `payments.status=CONFIRMED`,
   - `orders.status=PAID`,
   - post-paid DM клиенту отправлен.
5. Повторить `CONFIRMED` webhook (если возможно):
   - нет дублей критичных side-effects.

## 2) Orders topics smoke

1. При новом заказе проверить:
   - уведомление в операционной теме заказов;
   - запись/карточку в теме клиента.
2. При оплате проверить:
   - paid-уведомление в теме клиента.

## 3) Broadcasts smoke

1. Запустить рассылку из designated темы.
2. Проверить summary:
   - delivered/blocked/failed.
3. Нажать `Удалить рассылку у всех`.
4. Проверить:
   - delete summary,
   - повторный callback не ломает состояние.

## 4) Support smoke

1. Клиент -> бот:
   - сообщение попадает в тему клиента;
   - notify приходит в support topic.
2. Менеджер из темы клиента -> клиент:
   - relay работает;
   - ошибки доставки видимы.

## 5) Admin smoke

1. Админ из allowlist открывает `/admin`.
2. Неadmin получает deny на `/admin` и `/api/admin/*`.
3. Работают:
   - dashboard,
   - outbox list,
   - reprocess,
   - health endpoint.

## 6) Финальная проверка удаления Sambot

1. Поиск по репозиторию:
   - `sambot`
   - `SAMBOT_`
   - `paid_sambot_sent`
2. Убедиться, что нет runtime-упоминаний в `backend/*`.
3. Убедиться, что docs не утверждают активный Sambot fallback.

