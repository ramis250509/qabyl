// Шаги подключения салона к WhatsApp Cloud API через Embedded Signup.
//
// Разделение с wa-onboarding.functions.ts намеренное: здесь только разговор с Graph API, без
// доступа к базе и без проверки прав. Так каждый шаг можно проверить отдельно, а серверная
// функция остаётся тонкой и занимается своим — правами и сохранением.
//
// Почему не переиспользуем wa-cloud.server.ts: тот работает с ОДНИМ салоном от его имени
// (отправить сообщение, забрать медиа). Здесь наоборот — вызовы от имени приложения Qabyl над
// чужим бизнесом, и права на них даёт статус Tech Provider.
//
// Сеть, ретраи и разбор ошибок Meta живут в meta-graph.server.ts — здесь только смысл шагов.
import { graphCall, humanGraphError } from "@/lib/meta-graph.server";

export type OnboardingStep = {
  step: string;
  ok: boolean;
  /** Шаг прошёл потому, что делать было нечего — объект уже существовал. */
  existed?: boolean;
  /** Человекочитаемая причина. Показывается владельцу, поэтому без кодов и стектрейсов. */
  detail?: string;
};

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

  // Ретраев здесь НЕТ намеренно. Код одноразовый и живёт минуты: если Meta уже его приняла и
  // ответ потерялся по дороге, второй запрос вернёт «код использован», и мы перепишем настоящую
  // причину выдуманной. Лучше честно сказать «не получилось, нажмите ещё раз».
  const res = await graphCall<{ access_token?: string }>("oauth/access_token", {
    retries: 0,
    query: { client_id: appId, client_secret: appSecret, code },
  });
  if (!res.ok) return { ok: false, error: humanGraphError(res.error) };

  const token = res.data?.access_token;
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
  const res = await graphCall(`${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: "POST",
    token,
  });
  return res.ok
    ? { step: "subscribe", ok: true }
    : { step: "subscribe", ok: false, detail: humanGraphError(res.error) };
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
  const res = await graphCall(`${encodeURIComponent(phoneNumberId)}/register`, {
    method: "POST",
    token,
    body: { messaging_product: "whatsapp", pin },
  });
  if (res.ok) return { step: "register", ok: true };

  const already = /already.*registered|already exists/i.test(res.error.message);
  return already
    ? { step: "register", ok: true, detail: "номер уже зарегистрирован" }
    : { step: "register", ok: false, detail: humanGraphError(res.error) };
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
  {
    // Самоперенос и самоотмена раньше брали owner_new_booking — единственный шаблон для владельца,
    // какой был. Внутри 24 часов это незаметно (уходит свободный текст), а вне окна владелица
    // получала «Новая запись 🔔» про ОТМЕНЁННУЮ запись и держала слот занятым.
    kind: "owner_change",
    name: "owner_booking_changed",
    header: "Клиент изменил запись",
    body: "Клиент {{1}} изменил запись через ссылку 🔄\n\n{{2}}\n\nУслуга {{3}}, мастер {{4}}.\n\nВсе записи в панели: https://qabyl.com/admin/calendar",
    examples: ["Айгуль", "Перенос на 14 августа в 16:00", "маникюр", "Бегимай"],
  },
] as const;

/**
 * Заводит комплект шаблонов на WABA салона.
 *
 * Ради этого шага всё и затевалось: владелица салона не должна видеть редактор шаблонов Meta —
 * он съедает пробелы перед переменными, дописывает скобки к `{{` и уносит длинное тире в конец
 * строки. Шесть штук руками стоят часа и нескольких отказов.
 *
 * Уже существующий шаблон пропускаем, а не считаем ошибкой: повторный прогон — штатная ситуация
 * (переподключили салон, добавили седьмой шаблон).
 *
 * СОЗДАН ≠ ОДОБРЕН. Meta принимает шаблон в статусе PENDING и модерирует его отдельно, от минут
 * до часов. Поэтому статус здесь проставляется PENDING, а не APPROVED, и решение «можно ли уже
 * слать» принимается не тут, а в refreshWaConnection, которая спрашивает Meta. Раньше флаг
 * готовности поднимался по факту создания — и каждое напоминание вне окна падало с 132000.
 *
 * Ретраи выключены: создание не идемпотентно на нашей стороне, а повтор уже принятого шаблона
 * вернёт «уже существует» и замаскирует настоящую причину первой неудачи.
 */
export async function createNotificationTemplates(
  wabaId: string,
  token: string,
): Promise<{
  steps: OnboardingStep[];
  templates: Record<string, { name: string; lang: string; status: string; status_at: string }>;
}> {
  const steps: OnboardingStep[] = [];
  const templates: Record<
    string,
    { name: string; lang: string; status: string; status_at: string }
  > = {};
  const now = new Date().toISOString();

  for (const tpl of NOTIFICATION_TEMPLATES) {
    const res = await graphCall(`${encodeURIComponent(wabaId)}/message_templates`, {
      method: "POST",
      token,
      retries: 0,
      body: {
        name: tpl.name,
        language: "ru",
        category: "UTILITY",
        components: [
          { type: "HEADER", format: "TEXT", text: tpl.header },
          // example.body_text — массив НАБОРОВ примеров, отсюда вложенность. Одного набора
          // достаточно: Meta проверяет шаблон, а не перебирает варианты.
          { type: "BODY", text: tpl.body, example: { body_text: [[...tpl.examples]] } },
        ],
      },
    });

    // Об уже существующем шаблоне Meta сообщает минимум двумя разными фразами, и вторая —
    // «There is already Russian content for this template» — слов "already exists" не содержит.
    // Проверка на одну только первую превращала штатный повторный прогон в четыре отказа подряд.
    const already =
      !res.ok &&
      /already exists|there is already .+ content for this template/i.test(res.error.message);

    if (res.ok || already) {
      // Имя записываем в обоих случаях: салону нужно, чтобы отправка знала, чем слать, а
      // существовал шаблон до нас или создан сейчас — для этого безразлично.
      //
      // Статус существующего ставим UNKNOWN, а не PENDING: мы про него ничего не знаем, он мог
      // быть одобрен полгода назад или отклонён вчера. Настоящий придёт из синхронизации.
      templates[tpl.kind] = {
        name: tpl.name,
        lang: "ru",
        status: already ? "UNKNOWN" : "PENDING",
        status_at: now,
      };
      steps.push({
        step: `template:${tpl.name}`,
        ok: true,
        existed: already,
        detail: already ? "уже существует" : undefined,
      });
    } else {
      steps.push({
        step: `template:${tpl.name}`,
        ok: false,
        detail: humanGraphError(res.error),
      });
    }
  }

  return { steps, templates };
}
