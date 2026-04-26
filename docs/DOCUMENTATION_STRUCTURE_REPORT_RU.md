# DOCUMENTATION_STRUCTURE_REPORT_RU

## 1) Найденные документы (до реорганизации)

В репозитории были обнаружены 20 markdown-файлов в `docs/`:
- архитектурный аудит, data flow, Sambot dependency, target architecture;
- stage-отчёты (Stage1/Stage2);
- admin implementation/checklist;
- hardening/rollout/runbook;
- preprod/payment/admin access/localization/smoke;
- change map/migration plan.

Проблемы исходного состояния:
- дублирование тем между несколькими файлами;
- смешение финальных документов и промежуточных stage-артефактов;
- отсутствие единого корневого `README.md`;
- отсутствие единого навигатора `docs/README.md`.

## 2) Что оставлено как итоговая документация

Новый канонический набор:
- `README.md` (корневой обзор репозитория)
- `docs/README.md`
- `docs/architecture.md`
- `docs/data-flow.md`
- `docs/telegram-topics.md`
- `docs/payment-flow.md`
- `docs/admin-panel.md`
- `docs/admin-access.md`
- `docs/sambot.md`
- `docs/SAMBOT_REMOVAL_REPORT_RU.md`
- `docs/POST_SAMBOT_REGRESSION_CHECKLIST_RU.md`
- `docs/operations.md`
- `docs/testing.md`
- `docs/localization.md`
- `docs/changelog-migration.md`
- `docs/DOCUMENTATION_STRUCTURE_REPORT_RU.md`

## 3) Что объединено

Объединение по смыслу:
- Stage1/Stage2/Migration/ChangeMap -> `docs/changelog-migration.md` + профильные документы.
- Hardening/Rollout/Runbook -> `docs/operations.md`.
- Тестовые планы/чеклисты -> `docs/testing.md`.
- Sambot dependency/sweep -> `docs/sambot.md` + `docs/SAMBOT_REMOVAL_REPORT_RU.md`.
- Payment regression + payment sections -> `docs/payment-flow.md`.
- Admin implementation + access docs -> `docs/admin-panel.md` и `docs/admin-access.md`.

## 4) Что удалено

Удалены старые/дублирующие документы, содержание которых перенесено в канонические файлы.

## 5) Почему так

- Один источник истины по каждой теме.
- Минимум когнитивного шума.
- Быстрый onboarding нового разработчика.
- Удобная эксплуатация перед релизом и при инцидентах.

## 6) Итоговая структура

- Корень: только `README.md` (для документации).
- Вся актуальная проектная документация — только в `docs/`.

## 7) Что читать новому разработчику в первую очередь

1. `README.md`
2. `docs/architecture.md`
3. `docs/payment-flow.md`
4. `docs/telegram-topics.md`
5. `docs/admin-access.md`
6. `docs/operations.md`
7. `docs/testing.md`

