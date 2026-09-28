/**
 * Создаёт пять шаблонов уведомлений на указанном WABA через Graph API.
 *
 * Зачем: редактор шаблонов в WhatsApp Manager враждебен к вводу — он дописывает закрывающие
 * скобки к `{{`, съедает пробел перед вставленной переменной и уносит длинное тире в конец
 * строки. Пять шаблонов руками — это час работы и три отказа. Через API это один запрос на
 * шаблон, и текст попадает ровно такой, какой написан здесь.
 *
 * Шаблоны привязаны к WABA, а не к номеру, и между аккаунтами не переносятся. Поэтому скрипт
 * принимает WABA_ID: для каждого нового салона его нужно прогнать заново. Позже эта же логика
 * переедет в онбординг (Embedded Signup), чтобы владелец салона вообще не видел полей Meta.
 *
 * ВАЖНО: тексты и порядок {{n}} здесь — контракт с `supabase/functions/send-whatsapp/index.ts`.
 * Меняешь порядок тут — меняй и там, иначе Meta ответит 132000 (несовпадение числа параметров)
 * либо клиент увидит имя мастера на месте услуги. Контракт описан в docs/WA-CLOUD-MIGRATION.md.
 *
 * Запуск:
 *   WABA_ID=... WA_TOKEN=... bun scripts/create-wa-templates.ts
 *   WABA_ID=... WA_TOKEN=... bun scripts/create-wa-templates.ts --dry-run
 *
 * Токен нужен постоянный, от системного пользователя, с правом whatsapp_business_management.
 * Временный токен из вкладки API Setup живёт 24 часа и годится только на разовую проверку.
 */

const GRAPH_VERSION = process.env.WA_CLOUD_API_VERSION || "v25.0";
const WABA_ID = process.env.WABA_ID;
const WA_TOKEN = process.env.WA_TOKEN;
const DRY_RUN = process.argv.includes("--dry-run");

interface TemplateDef {
  name: string;
  category?: "UTILITY" | "MARKETING";
  /** Жирная строка над сообщением. Пустой HEADER Meta отклоняет — либо текст, либо секции нет. */
  header: string;
  body: string;
  /** По одному примеру на каждый {{n}}, В ТОМ ЖЕ ПОРЯДКЕ. Без них шаблон отклоняют. */
  examples: string[];
  /** Что подставляет send-whatsapp — для читателя, в запрос не уходит. */
  contract: string;
}

const TEMPLATES: TemplateDef[] = [
  {
    name: "booking_confirmation",
    header: "Запись подтверждена",
    contract: "имя · мастер · услуга · дата и время · токен ссылки",
    body: [
      "Здравствуйте, {{1}}!",
      "",
      "Записали вас к {{2}} на {{3}}, {{4}} ✅",
      "",
      "Если ваши планы поменяются, перенести или отменить можно тут: https://qabyl.com/manage/{{5}}",
      "",
      "Ждём вас! 😊",
    ].join("\n"),
    examples: ["Айгуль", "Бегимай", "маникюр", "12 августа в 19:00", "a7f3c9e2b1d4"],
  },
  {
    name: "visit_reminder",
    header: "Напоминание о записи",
    // Напоминание уходит за два часа до визита, поэтому говорит «сегодня» и получает голое
    // время без даты — в отличие от остальных видов.
    contract: "имя · время · мастер · токен ссылки",
    body: [
      "Здравствуйте, {{1}}!",
      "",
      "Напоминаем, что сегодня в {{2}} вас ждёт {{3}} ⏰",
      "",
      "Если у вас не получится прийти, дайте знать заранее или перенесите запись тут: https://qabyl.com/manage/{{4}}",
      "",
      "Будем рады видеть вас! 😊",
    ].join("\n"),
    examples: ["Айгуль", "19:00", "Бегимай", "a7f3c9e2b1d4"],
  },
  {
    name: "booking_rescheduled",
    header: "Запись перенесена",
    contract: "имя · новые дата и время · мастер · токен ссылки",
    body: [
      "Здравствуйте, {{1}}!",
      "",
      "Перенесли вашу запись, теперь ждём вас {{2}} 📅",
      "",
      "Вас примет {{3}}, как и договаривались.",
      "",
      "Если это время не подходит, напишите нам или выберите другое тут: https://qabyl.com/manage/{{4}}",
      "",
      "До встречи! 😊",
    ].join("\n"),
    examples: ["Айгуль", "14 августа в 16:00", "Бегимай", "a7f3c9e2b1d4"],
  },
  {
    name: "booking_cancelled",
    header: "Запись отменена",
    // Ссылки нет намеренно: после отмены токен уже ничем не управляет, вести клиента на
    // страницу «запись не найдена» незачем.
    contract: "имя · дата и время",
    body: [
      "Здравствуйте, {{1}}.",
      "",
      "Отменили вашу запись на {{2}}.",
      "",
      "Если это вышло случайно или захотите прийти в другой день, просто напишите нам сюда, всё оформим 😊",
    ].join("\n"),
    examples: ["Айгуль", "12 августа в 19:00"],
  },
  {
    name: "booking_restored",
    header: "Запись восстановлена",
    contract: "имя · дата и время · мастер · токен ссылки",
    body: [
      "Здравствуйте, {{1}}!",
      "",
      "Ваша запись восстановлена — ждём вас {{2}} у специалиста {{3}} ✅",
      "",
      "Изменить запись можно тут: https://qabyl.com/manage/{{4}}",
    ].join("\n"),
    examples: ["Айгуль", "14 августа в 16:00", "Бегимай", "a7f3c9e2b1d4"],
  },
  {
    name: "owner_new_booking",
    header: "Новая запись",
    // Уходит владельцу салона, а не клиенту: без приветствий, чтобы суть читалась сразу.
    contract: "клиент · услуга · мастер · дата и время · телефон",
    body: [
      "Новая запись 🔔",
      "",
      "Клиент {{1}} придёт на {{2}} к {{3}}, {{4}}.",
      "",
      "Телефон: {{5}}",
      "",
      "Все записи в панели: https://qabyl.com/admin/calendar",
    ].join("\n"),
    examples: ["Айгуль", "маникюр", "Бегимай", "12 августа в 19:00", "+996 555 123 456"],
  },
];

// Marketing хранится отдельно от transactional-набора: Meta требует отдельную категорию,
// а отправка допустима только клиентам с зафиксированным marketing opt-in.
const MARKETING_TEMPLATES: TemplateDef[] = [
  {
    name: "client_return_offer",
    category: "MARKETING",
    header: "Будем рады видеть вас снова",
    contract: "имя · название бизнеса · предложение · срок",
    body: "Здравствуйте, {{1}}! Давно не виделись в {{2}}. Для вас есть предложение: {{3}}. Оно действует до {{4}}. Если сообщения неактуальны, ответьте «Стоп».",
    examples: ["Айгуль", "Qabyl Clinic", "скидка 10% на повторный приём", "31 августа"],
  },
  {
    name: "service_repeat_reminder",
    category: "MARKETING",
    header: "Пора повторить услугу?",
    contract: "имя · услуга · название бизнеса",
    body: "Здравствуйте, {{1}}! Возможно, пришло время повторить {{2}} в {{3}}. Ответьте на это сообщение — подберём удобное время. Если сообщения неактуальны, ответьте «Стоп».",
    examples: ["Айгуль", "процедуру ухода", "Qabyl Clinic"],
  },
];

function buildPayload(t: TemplateDef) {
  return {
    name: t.name,
    language: "ru",
    category: t.category ?? "UTILITY",
    components: [
      { type: "HEADER", format: "TEXT", text: t.header },
      // example.body_text — массив НАБОРОВ примеров, отсюда вложенный массив. Один набор нам
      // достаточен: Meta проверяет шаблон, а не перебирает варианты.
      { type: "BODY", text: t.body, example: { body_text: [t.examples] } },
    ],
  };
}

/** Сверяет, что число {{n}} в тексте совпадает с числом примеров: ловим опечатку до отправки. */
function placeholderCount(body: string): number {
  const found = new Set(body.match(/\{\{\d+\}\}/g) ?? []);
  return found.size;
}

async function createTemplate(t: TemplateDef): Promise<boolean> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/message_templates`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_TOKEN}`,
    },
    body: JSON.stringify(buildPayload(t)),
  });

  const json: any = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(
      `  ✅ ${t.name} — создан, статус ${json.status ?? "PENDING"}, id ${json.id ?? "?"}`,
    );
    return true;
  }

  const err = json?.error ?? {};
  const detail = err.error_user_msg || err.message || `HTTP ${res.status}`;
  // Повторный прогон на том же WABA — обычное дело (добавили шаблон, гоняем скрипт снова).
  // Это не ошибка, о которой стоит кричать.
  if (String(detail).includes("already exists")) {
    console.log(`  ⏭  ${t.name} — уже существует на этом WABA, пропускаю`);
    return true;
  }
  console.error(`  ❌ ${t.name} — ${detail}`);
  return false;
}

async function main() {
  if (!WABA_ID || !WA_TOKEN) {
    console.error("Нужны переменные окружения WABA_ID и WA_TOKEN.");
    console.error(
      "Пример: WABA_ID=2216329892541913 WA_TOKEN=EAA... bun scripts/create-wa-templates.ts",
    );
    process.exit(1);
  }

  // Расхождение текста и примеров даёт отказ уже на стороне Meta, где причина формулируется
  // невнятно. Дешевле поймать здесь.
  let broken = false;
  const selected = process.argv.includes("--include-marketing")
    ? [...TEMPLATES, ...MARKETING_TEMPLATES]
    : TEMPLATES;
  for (const t of selected) {
    const n = placeholderCount(t.body);
    if (n !== t.examples.length) {
      console.error(`❌ ${t.name}: ${n} плейсхолдеров, но ${t.examples.length} примеров`);
      broken = true;
    }
  }
  if (broken) process.exit(1);

  console.log(`WABA ${WABA_ID}, Graph ${GRAPH_VERSION}, шаблонов: ${selected.length}\n`);

  if (DRY_RUN) {
    for (const t of selected) {
      console.log(`── ${t.name} · ${t.contract}`);
      console.log(JSON.stringify(buildPayload(t), null, 2));
      console.log();
    }
    console.log("Пробный прогон, ничего не отправлено. Убери --dry-run, чтобы создать.");
    return;
  }

  let ok = 0;
  for (const t of TEMPLATES) {
    console.log(`── ${t.name} · ${t.contract}`);
    if (await createTemplate(t)) ok++;
  }

  console.log(`\nГотово: ${ok} из ${TEMPLATES.length}.`);
  console.log("Модерация обычно занимает от нескольких минут до пары часов.");
  console.log(
    "Статус: WhatsApp Manager → Message templates, либо письмом (Template status updates).",
  );
  if (ok < TEMPLATES.length) process.exit(1);
}

main().catch((e) => {
  console.error("Сорвалось:", e?.message ?? e);
  process.exit(1);
});
