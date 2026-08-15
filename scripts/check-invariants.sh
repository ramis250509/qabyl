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

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SUPABASE_DB_URL не задан." >&2
  exit 2
fi

SQL_FILE="$(dirname "$0")/../supabase/tests/schema_invariants.sql"
if [ ! -f "$SQL_FILE" ]; then
  echo "Не найден $SQL_FILE" >&2
  exit 2
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
