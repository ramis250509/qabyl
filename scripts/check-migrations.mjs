#!/usr/bin/env node
/**
 * Сверка миграций репозитория с тем, что реально применено к базе.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО. Supabase MCP (`apply_migration`) и дашборд не принимают номер
 * версии — они присваивают свой, по времени применения. Имя файла говорит одно, запись
 * в supabase_migrations.schema_migrations — другое, и честно применённая миграция
 * выглядит пропущенной. 19.08.2026 так «пропало» пять миграций, применены были все.
 *
 * РЕШЕНИЕ: сверять по ИМЕНИ, а не по номеру. Имя (`followups`, `whatsapp_cloud_api`)
 * при применении сохраняется — дрейфует только номер. Имя и есть устойчивый ключ.
 *
 * Миграции до 20260630 пришли из Lovable и записаны в базе с именами-UUID — для них
 * имя бесполезно, поэтому они сверяются по номеру.
 *
 * ИСПОЛЬЗОВАНИЕ. Получи список из базы (Supabase MCP → list_migrations) и подай сюда:
 *
 *   node scripts/check-migrations.mjs < db-migrations.json
 *
 * Ожидается JSON: либо {"migrations":[{version,name},...]}, либо просто массив.
 * Код возврата 1, если найдено настоящее расхождение.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOVABLE_ERA = "20260630"; // до этой даты имена в базе — UUID, сверяем по номеру

const local = readdirSync(join(ROOT, "supabase", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => {
    const m = /^(\d{14})_(.+)\.sql$/.exec(f);
    return m ? { version: m[1], name: m[2], file: f } : { version: null, name: null, file: f };
  });

const malformed = local.filter((x) => !x.version);

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("Не удалось разобрать JSON со списком миграций базы (подай его в stdin).");
    process.exit(2);
  }
  const db = (Array.isArray(parsed) ? parsed : (parsed.migrations ?? [])).map((r) => ({
    version: String(r.version),
    name: String(r.name ?? ""),
  }));
  if (db.length === 0) {
    console.error("Список миграций базы пуст — похоже, подан не тот JSON.");
    process.exit(2);
  }

  const dbByName = new Map(db.filter((r) => r.name).map((r) => [r.name, r]));
  const dbByVersion = new Map(db.map((r) => [r.version, r]));

  const missing = []; // есть в репозитории, нет в базе — настоящая проблема
  const drifted = []; // применено, но под другим номером — не проблема, просто к сведению

  for (const f of local) {
    if (!f.version) continue;
    if (f.version < LOVABLE_ERA) {
      if (!dbByVersion.has(f.version)) missing.push(f);
      continue;
    }
    const hit = dbByName.get(f.name);
    if (!hit) {
      missing.push(f);
    } else if (hit.version !== f.version) {
      drifted.push({ ...f, dbVersion: hit.version });
    }
  }

  const localNames = new Set(local.filter((f) => f.name).map((f) => f.name));
  const localVersions = new Set(local.filter((f) => f.version).map((f) => f.version));
  const orphans = db.filter(
    (r) => r.version >= LOVABLE_ERA && !localNames.has(r.name) && !localVersions.has(r.version),
  );

  console.log(`Локальных файлов: ${local.length}   Записей в базе: ${db.length}`);

  if (malformed.length) {
    console.log(`\n[!] Имена не по формату YYYYMMDDHHMMSS_имя.sql (${malformed.length}):`);
    for (const f of malformed) console.log("    " + f.file);
  }

  const dupes = [...localVersions].filter((v) => local.filter((f) => f.version === v).length > 1);
  if (dupes.length) {
    console.log(`\n[!] Одинаковые метки времени — порядок применения неопределён:`);
    for (const v of dupes) console.log("    " + v);
  }

  if (drifted.length) {
    console.log(`\n[i] Применены под другим номером (это НОРМА, не чини):`);
    for (const f of drifted) console.log(`    ${f.file}  →  в базе ${f.dbVersion}`);
  }

  if (orphans.length) {
    console.log(`\n[!] Есть в базе, но НЕТ файла в репозитории — схема не развернётся с нуля:`);
    for (const r of orphans) console.log(`    ${r.version}  ${r.name}`);
  }

  if (missing.length) {
    console.log(`\n[X] НЕ ПРИМЕНЕНЫ к базе:`);
    for (const f of missing) console.log("    " + f.file);
    console.log(
      "\n    Прежде чем применять — проверь по объектам! Миграцию могли накатить\n" +
        "    через SQL Editor мимо учёта: тогда объекты в базе есть, а записи нет.",
    );
  }

  const bad = missing.length + orphans.length + malformed.length + dupes.length;
  console.log(bad === 0 ? "\nOK: репозиторий и база сходятся." : `\nТребует внимания: ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
});
