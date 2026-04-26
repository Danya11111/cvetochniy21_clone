# Экран "Рассылки" как growth-инструмент (mobile)

## Цель

Экран `Рассылки` переведен из режима "журнал доставок" в режим growth-управления:
- видно, какие кампании сработали хорошо;
- видно, где потерян охват (ошибки + блокировки);
- видно, какие кампании стоит повторить;
- есть быстрые действия для операционного и маркетингового контура.

## Структура экрана

Файлы:
- `frontend/admin/app.js`
- `frontend/admin/styles.css`

Новый mobile flow:
1. Hero KPI по каналу: доставлено / потерянный охват / блокировки.
2. Кликабельный summary-strip:
   - кампаний,
   - успешные,
   - проблемные,
   - идут сейчас,
   - стоит повторить.
3. Сегментные фильтры:
   - Все, Последние, Успешные, Проблемные,
   - Высокий охват, С ошибками, С блокировками,
   - Идут сейчас, Можно повторить,
   - Завершенные, Удаленные.
4. Блок "Что важно по рассылкам" (короткий управленческий контекст).
5. Блок "Потерянный охват" с топ-кампаниями по потере.
6. Карточки кампаний с business-метриками и health-индикаторами.

## Summary metrics

Summary endpoint: `GET /api/admin/broadcasts/summary`

Возвращает:
- `totals`:
  - `totalCampaigns`
  - `successfulCampaigns`
  - `problematicCampaigns`
  - `runningCampaigns`
  - `deliveredMessages`
  - `lostReachCount`
  - `blockedMessages`
- `segments`:
  - `repeatableCampaigns`
  - `highReachCampaigns`
  - `failedCampaigns`
  - `blockedCampaigns`
  - `doneCampaigns`
  - `deletedCampaigns`
- `lostReach`:
  - `totalLostReach`
  - `blockedMessages`
  - `failedMessages`
  - `topCampaigns[]`
- `highlights[]` для блока "Что важно".

## Derived fields кампании

Список и summary используют enriched DTO:
- `delivered_count`
- `failed_count`
- `blocked_count`
- `total_recipients`
- `delivered_pct`
- `failed_pct`
- `blocked_pct`
- `lost_reach_count`
- `lost_reach_pct`
- `campaign_health`
- `campaign_tier`
- `is_problematic`
- `is_repeatable_candidate`
- `is_high_reach`
- `campaign_subtitle`
- `campaign_attention_level`
- `campaign_attention_reason`
- `campaign_quality_score`
- `estimated_outcome_label`
- `delete_for_all_count`

## Как определяется successful / problematic / repeatable

Rules-based классификация (без ML):

- `successful`
  - высокий `delivered_pct`;
  - низкие `failed_pct` и `blocked_pct`.

- `problematic`
  - повышенный `failed_pct` или `blocked_pct`;
  - либо высокий `lost_reach_pct`.

- `repeatable`
  - хорошая доставляемость и низкий риск;
  - подходит как кандидат "взять за основу".

Дополнительно:
- `running` — кампания выполняется;
- `deleted` — удаленная;
- `completed` — завершенная без выраженных проблем/сильных сигналов.

## Lost reach block

`lost_reach_count = failed_count + blocked_count`.

Смысл блока:
- показывает масштаб недоохвата;
- отделяет ошибки доставки от блокировок;
- выделяет кампании с максимальной потерей охвата (`topCampaigns`).

Важно: без фейковой финансовой атрибуции — только честные прокси-метрики канала.

## Действия из карточки кампании

Доступные действия:
- `Открыть` (деталь кампании);
- `Повторить` (быстрый переход к сегменту repeatable, как light playbook);
- `Удалить у всех` (существующая operational функция).

## Связь с Главной и CRM-контуром

Экран поддерживает deep-link/filter-state через `broadcastsFilter`, в том числе:
- `successful`
- `problematic`
- `running`
- `blocked`
- `failed`
- `repeatable`

Поддержана обратная совместимость со старыми action payload (`RUNNING`, `DONE`, `DELETED`).

## Backend изменения

Изменения в:
- `backend/admin-repository.js`
  - расширен `listBroadcasts()` enriched полями;
  - добавлен `getBroadcastsSummary()`;
  - `getBroadcast()` возвращает enriched campaign.
- `backend/admin-routes.js`
  - добавлен endpoint `GET /api/admin/broadcasts/summary`.

## Ограничения этапа

На этом шаге не реализованы:
- полноценный A/B engine;
- точная выручечная атрибуция кампаний;
- predictive/automation journeys.

Сделан фокус на управляемый mobile growth-экран с честной диагностикой охвата и качества канала.
