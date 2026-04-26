# Карточка рассылки как premium growth-detail screen (mobile)

## Цель этапа

Карточка кампании переведена из "технической детализации" в управленческий growth-detail экран:
- сразу видно качество кампании и риск канала;
- отдельно подсвечен потерянный охват как потеря касания с клиентами;
- есть verdict по повторяемости кампании;
- есть practical next steps с быстрыми CTA.

Без фейкового ROI: используем прокси-метрики качества канала, а не искусственную денежную атрибуцию.

## Файлы этапа

- `backend/admin-repository.js`
- `frontend/admin/app.js`
- `frontend/admin/styles.css`
- `docs/admin-broadcast-detail-growth.md`

## Структура detail screen

1. **Hero / campaign summary**
   - `Кампания #id`, дата запуска, статус;
   - `campaign_health`, `campaign_tier`;
   - `campaign_quality_score`;
   - `repeatability_status` + `repeatability_reason`;
   - короткий subtitle/summary.

2. **Delivery quality**
   - получатели, доставлено, ошибки, блокировки;
   - проценты `delivered_pct`, `failed_pct`, `blocked_pct`.

3. **Lost reach block**
   - `lost_reach_count`, `lost_reach_pct`;
   - раскладка: ошибки vs блокировки;
   - объяснение, что потерян охват = потерянные касания.

4. **Growth interpretation**
   - verdict по повторяемости;
   - `quality_insights[]` (tone/title/message/priority/optional CTA).

5. **Action layer**
   - использовать как основу/повторить;
   - открыть ошибки;
   - открыть получателей/сегмент;
   - удалить у всех;
   - назад к списку без потери фильтра.

6. **Secondary detail**
   - `completed_at`, `duration`;
   - `delete_for_all_count`;
   - `error_summary.last_error_summary`;
   - `error_summary.top_error_types`;
   - `recipient_breakdown`.

## Derived fields detail DTO

`GET /api/admin/broadcasts/:id` теперь возвращает расширенный DTO:

- `campaign`
  - `campaign_health`
  - `campaign_tier`
  - `campaign_quality_score`
  - `repeatability_status`
  - `repeatability_reason`
  - `repeatability_label`
  - `subtitle`
  - `campaign_summary_text`
- `delivery_quality`
  - `delivered_pct`
  - `failed_pct`
  - `blocked_pct`
  - `quality_score`
- `recipient_breakdown`
  - `total_recipients`
  - `delivered_count`
  - `failed_count`
  - `blocked_count`
  - `lost_reach_count`
  - `delete_for_all_count`
- `lost_reach`
  - `lost_reach_count`
  - `lost_reach_pct`
  - `failed_count`
  - `blocked_count`
  - `summary_text`
- `error_summary`
  - `has_errors`
  - `total_problematic`
  - `last_error_summary`
  - `top_error_types[]`
- `quality_insights[]`
- `next_actions[]`
- `details`
  - `completed_at`
  - `duration_minutes`
  - `duration_label`
  - `delete_for_all_count`
  - `source_preview`

## Repeatability logic

`repeatability_status` вычисляется rules-based:

- `repeat`
  - высокая доставляемость;
  - низкие блокировки;
  - низкий lost reach.

- `improve_and_repeat`
  - среднее качество;
  - есть умеренные риски;
  - сначала доработать сегмент/качество, потом повторять.

- `do_not_repeat`
  - высокий `lost_reach_pct` и/или `blocked_pct` и/или `failed_pct`;
  - без пересмотра повтор может ухудшить канал.

Это прозрачная explainable logic без черного ящика.

## Quality insights

`quality_insights[]` строится rules-based и может содержать:

- "Кампания сохранила хороший охват";
- "Потерянный охват выше нормы";
- "Блокировки выше обычного";
- "Ошибки доставки заметны";
- "Кампанию можно использовать как основу" или "Перед повтором нужен пересмотр".

Каждый insight:
- `tone`
- `title`
- `message`
- `priority`
- `cta` (опционально).

## Next actions

`next_actions[]` формируется на основе repeatability + delivery quality:

- повторить на похожем сегменте;
- доработать и повторить;
- не повторять без пересмотра сегмента;
- проверить причины блокировок;
- посмотреть проблемных получателей;
- удалить у всех при необходимости.

Каждое действие:
- `title`
- `message`
- `priority`
- `ctaLabel`
- `action` (навигация/фильтр/detail).

## Lost reach block

Формула:

`lost_reach_count = failed_count + blocked_count`.

Смысл блока:
- показывает объем не дошедших сообщений;
- отделяет причины потери охвата (ошибки vs блокировки);
- объясняет влияние на канал как на качество контакта с аудиторией.

## Навигация и deep-link flow

- Из списка `Рассылки` кнопка "Открыть" ведет в `broadcast_detail`.
- В detail работает "Назад к рассылкам" с сохранением контекста фильтра списка.
- `apply-nav-action` поддерживает `campaignId`: из контекстных экранов (Главная/Action Center/Аналитика/другие) можно открыть конкретную кампанию напрямую.

## Empty / error / limited-data состояния

Реализованы состояния:
- кампания не выбрана;
- кампания не найдена;
- данных недостаточно;
- ошибок нет;
- блокировок нет (через метрики/insights);
- delete-for-all не запускался;
- ошибка загрузки (глобальный `errorState`).

## Что не включено в этот этап

- A/B testing engine;
- полноценный campaign builder;
- сложная денежная атрибуция и multi-touch ROI;
- advanced automation journeys.

Этап сфокусирован на premium mobile detail-экране качества и управляемости канала.
