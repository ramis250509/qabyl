#!/usr/bin/env bash
# Прогон supabase/tests/booking_integrity.sql на локальном стеке Supabase.
#
# Зачем отдельный скрипт: набор пишет в базу и потому требует настоящий Postgres
# с расширениями (btree_gist, pg_cron, vault) — на моках такое не проверить.
# Клиент psql берётся из самого контейнера базы, ставить его на машину не нужно.
# Это и есть та «одна команда», которой не хватало на Windows.
#
# Локально:
#   npx supabase start
#   bash scripts/check-booking-behaviour.sh
#
# Набор идёт в транзакции и заканчивается RAISE EXCEPTION с итогом — исключение
# и печатает результат, и откатывает фикстуры. Поэтому ненулевой код возврата
# psql здесь НОРМА, а судить надо по тексту итога.
set -uo pipefail

SQL_FILE="$(dirname "$0")/../supabase/tests/booking_integrity.sql"

fail_setup() {
  echo "" >&2
  echo "НЕ УДАЛОСЬ ЗАПУСТИТЬ ПРОВЕРКУ: $1" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "Поведенческие тесты не запустились: $1" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 2
}

[ -f "$SQL_FILE" ] || fail_setup "не найден файл $SQL_FILE"
command -v docker >/dev/null 2>&1 || fail_setup "не найден docker"

DB_CONTAINER="$(docker ps --format '{{.Names}}' | grep '^supabase_db' | head -1)"
[ -n "$DB_CONTAINER" ] || fail_setup "не запущен контейнер базы — сначала 'npx supabase start'"

echo "База: $DB_CONTAINER"
echo ""

# Предохранитель внутри файла требует явного разрешения на запись — выставляем
# его здесь, а не внутри набора, чтобы случайный psql-прогон по боевой базе
# ничего не натворил.
OUT="$( { echo "SET qabyl.allow_write_tests='yes';"; cat "$SQL_FILE"; } \
  | docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -q 2>&1 )"

echo "$OUT"

# Итоговая строка: «РЕЗУЛЬТАТ: N пройдено, M провалено.»
FAILED="$(printf '%s' "$OUT" | sed -n 's/.*пройдено, \([0-9][0-9]*\) провалено.*/\1/p' | head -1)"

if [ -z "$FAILED" ]; then
  fail_setup "в выводе нет итоговой строки — набор не доработал до конца"
fi

echo ""
if [ "$FAILED" -gt 0 ]; then
  echo "Провалено сценариев: $FAILED." >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "Поведенческие тесты: провалено $FAILED." >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

echo "Все поведенческие сценарии пройдены."
