// Шаги подключения салона к WhatsApp Cloud API через Embedded Signup.
//
// Разделение с wa-onboarding.functions.ts намеренное: здесь только разговор с Graph API, без
// доступа к базе и без проверки прав. Так каждый шаг можно проверить отдельно, а серверная
// функция остаётся тонкой и занимается своим — правами и сохранением.
//
// Почему не переиспользуем wa-cloud.server.ts: тот работает с ОДНИМ салоном от его имени
// (отправить сообщение, забрать медиа). Здесь наоборот — вызовы от имени приложения Qabyl над
// чужим бизнесом, и права на них даёт статус Tech Provider.

function graphBase(): string {
  const version = process.env.WA_CLOUD_API_VERSION || "v25.0";
  return `https://graph.facebook.com/${version}`;
}

export type OnboardingStep = {
  step: string;
  ok: boolean;
  /** Человекочитаемая причина. Показывается владельцу, поэтому без кодов и стектрейсов. */
  detail?: string;
};

/** Разбирает ответ Graph API: у Meta ошибка приезжает с HTTP 200 не реже, чем с 4xx. */
async function graphJson(res: Response): Promise<{ ok: boolean; json: any; error: string | null }> {
  const json = await res.json().catch(() => ({}));
  const err = json?.error;
  if (!res.ok || err) {
    const detail = err?.error_user_msg || err?.message || `HTTP ${res.status}`;
    return { ok: false, json, error: String(detail) };
  }
  return { ok: true, json, error: null };
}

/**
 * Меняет одноразовый код из Embedded Signup на долгоживущий токен бизнеса.
 *
 * Код приходит в браузер салона и живёт считанные минуты. Обмен идёт только сервер-к-серверу:
 * в нём участвует app secret, которому в браузере делать нечего.
 */
export async function exchangeCodeForToken(
  code: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const appId = process.env.META_APP_ID ?? "";
  const appSecret = process.env.META_APP_SECRET ?? "";
  if (!appId || !appSecret) {
    return { ok: false, error: "META_APP_ID или META_APP_SECRET не заданы на сервере" };
  }

  const url =
    `${graphBase()}/oauth/access_token` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&code=${encodeURIComponent(code)}`;

  const res = await fetch(url, { method: "GET" });
  const { ok, json, error } = await graphJson(res);
  if (!ok) return { ok: false, error: error ?? "обмен кода не удался" };

  const token = json?.access_token;
  if (!token) return { ok: false, error: "Meta не вернула access_token" };
  return { ok: true, token: String(token) };
}

/**
 * Подписывает приложение Qabyl на вебхуки WABA салона.
 *
 * Без этого шага салон подключён, но молчит: сообщения его клиентов просто не доходят до нас.
 * Адрес и поля подписки заданы один раз в настройках приложения — здесь только сама подписка.
 */
export async function subscribeAppToWaba(wabaId: string, token: string): Promise<OnboardingStep> {
  const res = await fetch(`${graphBase()}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const { ok, error } = await graphJson(res);
  return ok
    ? { step: "subscribe", ok: true }
    : { step: "subscribe", ok: false, detail: error ?? "не удалось подписать приложение" };
}

/**
 * Регистрирует номер в Cloud API.
 *
 * Для номеров, пришедших через coexistence, регистрация уже сделана на стороне Meta, и попытка
 * вернёт «already registered». Это НЕ ошибка подключения — салон в этом случае полностью рабочий,
 * поэтому такой ответ считаем успехом, иначе владелец увидит красное на ровном месте.
 *
 * PIN — двухфакторная защита номера. Салон его никогда не вводит: мы задаём его сами и нигде не
 * показываем, потому что для нашего сценария он лишний обряд, а не защита.
 */
export async function registerPhoneNumber(
  phoneNumberId: string,
  token: string,
  pin: string,
): Promise<OnboardingStep> {
  const res = await fetch(`${graphBase()}/${encodeURIComponent(phoneNumberId)}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });
  const { ok, error } = await graphJson(res);
  if (ok) return { step: "register", ok: true };

  const already = /already.*registered|already exists/i.test(error ?? "");
  return already
    ? { step: "register", ok: true, detail: "номер уже зарегистрирован" }
    : { step: "register", ok: false, detail: error ?? "не удалось зарегистрировать номер" };
}

/**
 * Пять шаблонов уведомлений — те же тексты, что в scripts/create-wa-templates.ts.
 *
 * ПОРЯДОК {{n}} — контракт с supabase/functions/send-whatsapp/index.ts. Меняешь здесь — меняй
 * там, иначе Meta ответит 132000 либо клиент увидит имя мастера на месте услуги. Контракт
 * описан в docs/WA-CLOUD-MIGRATION.md.
 */
export const NOTIFICATION_TEMPLATES = [
  {
    kind: "confirmation",
    name: "booking_confirmation",
    header: "Запись подтверждена",
    body: "Здравствуйте, {{1}}!\n\nЗаписали вас к {{2}} на {{3}}, {{4}} ✅\n\nЕсли ваши планы поменяются, перенести или отменить можно тут: https://qabyl.com/manage/{{5}}\n\nЖдём вас! 😊",
    examples: ["Айгуль", "Бегимай", "маникюр", "12 августа в 19:00", "a7f3c9e2b1d4"],
  },
  {
    kind: "reminder",
    name: "visit_reminder",
    header: "Напоминание о записи",
    body: "Здравствуйте, {{1}}!\n\nНапоминаем, что сегодня в {{2}} вас ждёт {{3}} ⏰\n\nЕсли у вас не получится прийти, дайте знать заранее или перенесите запись тут: https://qabyl.com/manage/{{4}}\n\nБудем рады видеть вас! 😊",
    examples: ["Айгуль", "19:00", "Бегимай", "a7f3c9e2b1d4"],
  },
  {
    kind: "reschedule",
    name: "booking_rescheduled",
    header: "Запись перенесена",
    body: "Здравствуйте, {{1}}!\n\nПеренесли вашу запись, теперь ждём вас {{2}} 📅\n\nВас примет {{3}}, как и договаривались.\n\nЕсли это время не подходит, напишите нам или выберите другое тут: https://qabyl.com/manage/{{4}}\n\nДо встречи! 😊",
    examples: ["Айгуль", "14 августа в 16:00", "Бегимай", "a7f3c9e2b1d4"],
  },
  {
    kind: "cancellation",
    name: "booking_cancelled",
    header: "Запись отменена",
    body: "Здравствуйте, {{1}}.\n\nОтменили вашу запись на {{2}}.\n\nЕсли это вышло случайно или захотите прийти в другой день, просто напишите нам сюда, всё оформим 😊",
    examples: ["Айгуль", "12 августа в 19:00"],
  },
  {
    kind: "owner_alert",
    name: "owner_new_booking",
    header: "Новая запись",
    body: "Новая запись 🔔\n\nКлиент {{1}} придёт на {{2}} к {{3}}, {{4}}.\n\nТелефон: {{5}}\n\nВсе записи в панели: https://qabyl.com/admin/calendar",
    examples: ["Айгуль", "маникюр", "Бегимай", "12 августа в 19:00", "+996 555 123 456"],
  },
] as const;

/**
 * Заводит пять шаблонов на WABA салона.
 *
 * Ради этого шага всё и затевалось: владелица салона не должна видеть редактор шаблонов Meta —
 * он съедает пробелы перед переменными, дописывает скобки к `{{` и уносит длинное тире в конец
 * строки. Пять штук руками стоят часа и нескольких отказов.
 *
 * Уже существующий шаблон пропускаем, а не считаем ошибкой: повторный прогон — штатная ситуация
 * (переподключили салон, добавили шестой шаблон).
 */
export async function createNotificationTemplates(
  wabaId: string,
  token: string,
): Promise<{ steps: OnboardingStep[]; templates: Record<string, { name: string; lang: string }> }> {
  const steps: OnboardingStep[] = [];
  const templates: Record<string, { name: string; lang: string }> = {};

  for (const tpl of NOTIFICATION_TEMPLATES) {
    const res = await fetch(`${graphBase()}/${encodeURIComponent(wabaId)}/message_templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: tpl.name,
        language: "ru",
        category: "UTILITY",
        components: [
          { type: "HEADER", format: "TEXT", text: tpl.header },
          // example.body_text — массив НАБОРОВ примеров, отсюда вложенность. Одного набора
          // достаточно: Meta проверяет шаблон, а не перебирает варианты.
          { type: "BODY", text: tpl.body, example: { body_text: [[...tpl.examples]] } },
        ],
      }),
    });

    const { ok, error } = await graphJson(res);
    const already = /already exists/i.test(error ?? "");
    if (ok || already) {
      // Имя записываем в обоих случаях: салону нужно, чтобы отправка знала, чем слать, а
      // существовал шаблон до нас или создан сейчас — для этого безразлично.
      templates[tpl.kind] = { name: tpl.name, lang: "ru" };
      steps.push({
        step: `template:${tpl.name}`,
        ok: true,
        detail: already ? "уже существует" : undefined,
      });
    } else {
      steps.push({ step: `template:${tpl.name}`, ok: false, detail: error ?? "отклонён" });
    }
  }

  return { steps, templates };
}
