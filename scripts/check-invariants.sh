#!/usr/bin/env bash
# Прогон supabase/tests/schema_invariants.sql с ненулевым кодом выхода при любом FAIL.
#
# Сам SQL-файл только печатает таблицу — так им удобнее пользоваться руками в
# SQL-редакторе. Превращать «в выводе есть слово FAIL» в «сборка упала» —
# работа этой обёртки.
#
# Запуск локально:
#   SUPABASE_DB_URL='postgresql://...' bash scripts/check-invariants.sh
set -euo pipefail

# Код выхода 2 означает «проверку не удалось запустить», в отличие от 1 —
# «проверки провалились». Различать их важно: первое чинится настройкой, второе
# означает регрессию в схеме. Поэтому причина всегда называется вслух.
fail_setup() {
  echo "" >&2
  echo "НЕ УДАЛОСЬ ЗАПУСТИТЬ ПРОВЕРКУ: $1" >&2
  # На GitHub то же самое попадает в сводку прогона, чтобы причина была видна
  # без раскрытия логов.
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "Проверка инвариантов не запустилась: $1" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 2
}

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  fail_setup "переменная SUPABASE_DB_URL пуста или не задана"
fi

if ! command -v psql >/dev/null 2>&1; then
  fail_setup "на машине нет клиента psql"
fi

SQL_FILE="$(dirname "$0")/../supabase/tests/schema_invariants.sql"
if [ ! -f "$SQL_FILE" ]; then
  fail_setup "не найден файл $SQL_FILE"
fi

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

# ON_ERROR_STOP, чтобы сломанный SQL не выглядел как «проверки прошли».
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 --no-psqlrc -f "$SQL_FILE" | tee "$OUT"

# Считаем строки со статусом FAIL. Слово ищем как отдельное поле, а не как
# подстроку: название проверки тоже может содержать «FAIL».
FAILED="$(grep -cE '\|\s*FAIL\s*\|' "$OUT" || true)"

if [ "${FAILED:-0}" -gt 0 ]; then
  echo ""
  echo "Провалено проверок: $FAILED. Схема разошлась с тем, что закрепил аудит." >&2
  exit 1
fi

echo ""
echo "Все инварианты схемы соблюдены."
