// Самостоятельная настройка салона: от «зарегистрировался» до «принимаю записи».
//
// ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ. До него завести салон мог только super_admin: INSERT на `salons`
// открыт единственной политике `has_role(auth.uid(),'super_admin')`, а новый пользователь не
// получал вообще никакой роли и упирался в экран «Нет доступа». То есть первый же шаг клиента
// требовал ручного вмешательства оператора — и никакой Embedded Signup этого не менял.
//
// ПОЧЕМУ ШАГИ — СЕРВЕРНЫЕ ФУНКЦИИ, А НЕ ЗАПРОСЫ ИЗ БРАУЗЕРА. Каждый шаг создаёт несколько
// связанных строк: услуги + категории, мастер + расписание + привязка к услугам. Половина такого
// набора хуже, чем ничего: салон с мастером без расписания выглядит настроенным и не отдаёт ни
// одного слота. Одна функция — один результат.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { INDUSTRY_ORDER, INDUSTRY_SITE, normalizeIndustry } from "@/lib/industries";
import { SERVICE_CATALOG_TEMPLATES, colorForCategoryIndex } from "@/lib/service-catalog-templates";

async function assertSalonAccess(supabase: any, userId: string, salonId: string) {
  const { data, error } = await supabase.rpc("has_salon_access", {
    _user_id: userId,
    _salon_id: salonId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

const industryEnum = z.enum(INDUSTRY_ORDER as [string, ...string[]]);

/** Часы работы филиала по умолчанию: пн–сб 09:00–20:00, воскресенье выходной. */
function defaultHours(): Record<string, { start: string; end: string }[]> {
  const h: Record<string, { start: string; end: string }[]> = {};
  for (let d = 0; d <= 6; d++) h[String(d)] = d === 0 ? [] : [{ start: "09:00", end: "20:00" }];
  return h;
}

/**
 * Шаг 1: создаёт салон и делает нажавшего его владельцем.
 *
 * Тяжёлая часть — в RPC `create_salon_for_owner`: она одной транзакцией заводит салон, главный
 * филиал, роль salon_admin и строку секретов. Здесь остаётся то, что к правам отношения не имеет:
 * отрасль, часы работы и тексты сайта по умолчанию.
 *
 * Отрасль записывается СРАЗУ, а не спрашивается потом: от неё зависит стартовый каталог услуг,
 * вопросы книги знаний, тексты сайта и поведение ассистента. Салон, у которого её нет, получает
 * «салон красоты» и потом удивляется, почему ассистент говорит про маникюр.
 */
export const createMySalon = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        name: z.string().trim().min(2).max(120),
        industry: industryEnum,
        timezone: z.string().min(3).max(64),
        phone: z.string().max(32).nullable().optional(),
        address: z.string().max(300).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    // RPC вызывается КЛИЕНТСКИМ клиентом пользователя, а не supabaseAdmin: внутри она читает
    // auth.uid(), чтобы понять, кого делать владельцем. Под service-role там был бы NULL, и
    // функция честно отказала бы.
    // `as any` на имени RPC — потому что типы Supabase генерируются из применённой схемы, а эта
    // функция появляется миграцией 20260909090000. Каст уйдёт со следующей генерацией типов.
    const { data: created, error } = await (context.supabase.rpc as any)("create_salon_for_owner", {
      _name: data.name,
      _timezone: data.timezone,
      _phone: data.phone ?? null,
      _address: data.address ?? null,
    });
    if (error) {
      // Единственная ожидаемая неудача — «у этого аккаунта уже есть салон». Остальные означают
      // поломку, и пересказывать их владельцу словами Postgres незачем.
      if (/уже есть салон/i.test(error.message)) throw new Error(error.message);
      throw new Error(`Не удалось создать салон: ${error.message}`);
    }
    const salonId = created as string | null;
    if (!salonId) throw new Error("Не удалось создать салон");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const industry = normalizeIndustry(data.industry);
    const site = INDUSTRY_SITE[industry];

    await Promise.all([
      supabaseAdmin
        .from("salon_ai_assistant")
        .upsert({ salon_id: salonId, industry } as any, { onConflict: "salon_id" }),
      // Часы работы ставим и салону, и филиалу: расписание слотов пересекает часы филиала с
      // графиком мастера, и пустой объект здесь означает «закрыто всегда».
      supabaseAdmin
        .from("salons")
        .update({
          working_hours: defaultHours(),
          hero_title: site?.hero_title ?? null,
          hero_subtitle: site?.hero_subtitle ?? null,
          about_text: site?.about_text ?? null,
        } as any)
        .eq("id", salonId),
      supabaseAdmin
        .from("branches")
        .update({ working_hours: defaultHours() } as any)
        .eq("salon_id", salonId),
    ]);

    const { data: salon } = await supabaseAdmin
      .from("salons")
      .select("id, slug, name")
      .eq("id", salonId)
      .maybeSingle();

    return {
      salonId,
      slug: ((salon as any)?.slug ?? "") as string,
    };
  });

/**
 * Шаг 2: заводит стартовый прайс-лист.
 *
 * Каталоги написаны под каждую отрасль и лежат в service-catalog-templates.ts. Владелец отмечает,
 * что из этого он делает, — и получает готовый прайс вместо тридцати пустых форм. Цены он
 * поправит: они заведомо «средние по рынку», и об этом сказано на экране.
 *
 * Повторный вызов не дублирует: услуга с таким же именем пропускается. Онбординг переживает
 * перезагрузку страницы и двойное нажатие, а это самый частый способ получить прайс из
 * шестидесяти позиций вместо тридцати.
 */
export const seedServiceCatalog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        industry: industryEnum,
        /** Имена услуг из каталога. Пусто — берём весь каталог. */
        names: z.array(z.string().max(200)).max(400).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const catalog = SERVICE_CATALOG_TEMPLATES[normalizeIndustry(data.industry)] ?? [];
    const wanted = data.names?.length ? new Set(data.names) : null;
    const picked = wanted ? catalog.filter((s) => wanted.has(s.name)) : catalog;
    if (picked.length === 0) return { ok: true as const, created: 0 };

    const { data: existing } = await supabaseAdmin
      .from("services")
      .select("name")
      .eq("salon_id", data.salonId);
    const have = new Set((existing ?? []).map((s: any) => String(s.name)));

    const categories = Array.from(new Set(picked.map((s) => s.category)));
    const rows = picked
      .filter((s) => !have.has(s.name))
      .map((s, i) => ({
        salon_id: data.salonId,
        name: s.name,
        category: s.category,
        description: s.description ?? null,
        duration_min: s.duration_min,
        duration_max_min: s.duration_max_min ?? null,
        price: s.price,
        price_max: s.price_max ?? null,
        price_type: s.price_type,
        color: colorForCategoryIndex(categories, s.category),
        sort_order: i,
        is_active: true,
      }));

    if (rows.length === 0) return { ok: true as const, created: 0 };

    const { error } = await supabaseAdmin.from("services").insert(rows as any);
    if (error) throw new Error(`Не удалось добавить услуги: ${error.message}`);

    // Порядок категорий на странице записи и в ответах ассистента — тот же, что в каталоге.
    // Без него категории показываются в порядке вставки, который ничего не значит.
    await supabaseAdmin
      .from("salons")
      .update({ category_order: categories } as any)
      .eq("id", data.salonId);

    return { ok: true as const, created: rows.length };
  });

/**
 * Шаг 3: заводит тех, кто принимает клиентов.
 *
 * ЧТО СОЗДАЁТСЯ НА КАЖДОГО. Строка мастера, привязка к главному филиалу, график на выбранные дни
 * и связь со ВСЕМИ услугами салона. Последнее — не лень, а осознанный выбор: у мастера без
 * привязанных услуг расписание пустое, и салон, который «всё настроил», не отдаёт ни одного
 * слота. Разделить услуги между мастерами можно потом, во вкладке «Мастера»; начать с «умеет
 * всё» безопаснее, чем с «не умеет ничего».
 */
export const seedTeam = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        masters: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(120),
              specialization: z.string().trim().max(160).optional(),
            }),
          )
          .min(1)
          .max(30),
        /** Дни недели, 0 = воскресенье. */
        weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        start: z.string().regex(/^\d{2}:\d{2}$/),
        end: z.string().regex(/^\d{2}:\d{2}$/),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);

    // Тот же провал, что уложил салон Lashes Nurzhan 04.08.2026: интервал, который заканчивается
    // раньше, чем начинается, проходит в базу, get_available_slots молча отбрасывает КАЖДОЕ окно,
    // и салон становится незаписываемым без единой ошибки. Строки «ЧЧ:ММ» дополнены нулями,
    // поэтому сравнение строк — это сравнение времени.
    if (data.start >= data.end) {
      throw new Error("Время окончания работы должно быть позже времени начала");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [{ data: branch }, { data: services }, { data: existingMasters }] = await Promise.all([
      supabaseAdmin
        .from("branches")
        .select("id")
        .eq("salon_id", data.salonId)
        .order("sort_order")
        .limit(1)
        .maybeSingle(),
      supabaseAdmin.from("services").select("id").eq("salon_id", data.salonId),
      supabaseAdmin.from("masters").select("name").eq("salon_id", data.salonId),
    ]);

    const branchId = (branch as any)?.id ?? null;
    const serviceIds = (services ?? []).map((s: any) => s.id as string);
    const have = new Set((existingMasters ?? []).map((m: any) => String(m.name)));

    const fresh = data.masters.filter((m) => !have.has(m.name));
    if (fresh.length === 0) return { ok: true as const, created: 0 };

    const { data: inserted, error } = await supabaseAdmin
      .from("masters")
      .insert(
        fresh.map((m, i) => ({
          salon_id: data.salonId,
          branch_id: branchId,
          name: m.name,
          specialization: m.specialization || null,
          sort_order: i,
          is_active: true,
        })) as any,
      )
      .select("id");
    if (error) throw new Error(`Не удалось добавить мастеров: ${error.message}`);

    const ids = (inserted ?? []).map((m: any) => m.id as string);

    const schedules = ids.flatMap((id) =>
      data.weekdays.map((d) => ({
        master_id: id,
        weekday: d,
        start_time: data.start,
        end_time: data.end,
      })),
    );
    const links = ids.flatMap((id) =>
      serviceIds.map((sid) => ({ master_id: id, service_id: sid })),
    );

    // Расписание и услуги — параллельно: обе вставки независимы, а вместе они и есть «мастер
    // готов принимать». Ошибка любой из них не откатывает мастера, но и не молчит.
    const [schedRes, linkRes] = await Promise.all([
      schedules.length
        ? supabaseAdmin.from("master_schedules").insert(schedules as any)
        : Promise.resolve({ error: null }),
      links.length
        ? supabaseAdmin.from("master_services").insert(links as any)
        : Promise.resolve({ error: null }),
    ]);
    if ((schedRes as any).error) {
      throw new Error(
        `Мастера добавлены, но график не сохранился: ${(schedRes as any).error.message}`,
      );
    }
    if ((linkRes as any).error) {
      throw new Error(
        `Мастера добавлены, но услуги не привязались: ${(linkRes as any).error.message}`,
      );
    }

    return { ok: true as const, created: ids.length };
  });

/**
 * Где салон находится на пути к первой записи.
 *
 * Считается на сервере, а не в браузере, по одной причине: этими же числами живёт и чеклист в
 * настройках, и виджет на дашборде. Две реализации одного вопроса неизбежно начинают отвечать
 * по-разному — обычно ровно тогда, когда владелец смотрит на оба экрана сразу.
 */
export const getOnboardingProgress = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSalonAccess(context.supabase, context.userId, data.salonId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { computeWaStatus } = await import("@/lib/wa-connection.server");

    const [salonRes, servicesRes, mastersRes, schedulesRes, secretsRes, apptRes] =
      await Promise.all([
        supabaseAdmin
          .from("salons")
          .select(
            "id, name, slug, phone, address, ai_assistant_enabled, whatsapp_enabled, instagram_enabled",
          )
          .eq("id", data.salonId)
          .maybeSingle(),
        supabaseAdmin
          .from("services")
          .select("id", { count: "exact", head: true })
          .eq("salon_id", data.salonId),
        supabaseAdmin
          .from("masters")
          .select("id")
          .eq("salon_id", data.salonId)
          .eq("is_active", true),
        // Мастер без графика — самая коварная из полунастроек: он есть в списке, виден клиенту и
        // не отдаёт ни одного слота. Считаем графики отдельно, чтобы отличить «мастер добавлен»
        // от «мастер может принимать».
        supabaseAdmin.from("master_schedules").select("master_id"),
        supabaseAdmin.from("salon_secrets").select("*").eq("salon_id", data.salonId).maybeSingle(),
        supabaseAdmin
          .from("appointments")
          .select("id", { count: "exact", head: true })
          .eq("salon_id", data.salonId),
      ]);

    const salon = (salonRes as any)?.data ?? null;
    const masterIds = new Set(((mastersRes as any)?.data ?? []).map((m: any) => m.id as string));
    const scheduled = new Set(
      ((schedulesRes as any)?.data ?? [])
        .map((s: any) => s.master_id as string)
        .filter((id: string) => masterIds.has(id)),
    );

    return {
      salonName: (salon?.name ?? "") as string,
      slug: (salon?.slug ?? "") as string,
      hasContacts: Boolean(salon?.phone || salon?.address),
      servicesCount: ((servicesRes as any)?.count ?? 0) as number,
      mastersCount: masterIds.size,
      /** Сколько мастеров реально могут принимать: есть график. */
      bookableMastersCount: scheduled.size,
      appointmentsCount: ((apptRes as any)?.count ?? 0) as number,
      assistantEnabled: Boolean(salon?.ai_assistant_enabled),
      notificationsEnabled: Boolean(salon?.whatsapp_enabled),
      whatsapp: computeWaStatus((secretsRes as any)?.data ?? null, {
        platformBilling: Boolean((process.env.YCLOUD_API_KEY ?? "").trim()),
      }),
      // Instagram считается здесь же, а не отдельным запросом с экрана: «состояние канала» —
      // один вопрос, и два разных ответа на него (дашборд говорит одно, вкладка «Каналы» другое)
      // появятся ровно в тот момент, когда владелец смотрит на оба экрана сразу.
      //
      // Подключён = есть чем отвечать (токен + аккаунт) И чем проверить подпись вебхука
      // (app secret). Без последнего маршрут /api/public/ig отказывает вообще всем — то есть
      // канал выглядит настроенным и молчит.
      instagram: {
        connected: Boolean(
          (secretsRes as any)?.data?.instagram_token &&
            (secretsRes as any)?.data?.instagram_user_id &&
            (secretsRes as any)?.data?.instagram_app_secret,
        ),
        enabled: Boolean(salon?.instagram_enabled),
      },
    };
  });
