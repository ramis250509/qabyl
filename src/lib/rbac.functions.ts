// Employee management: invite / assign role / link master profile / revoke.
// Callable by super_admin OR salon_admin of the given salon. Every change is
// audited into public.rbac_audit for compliance.
//
// The invitation flow uses Supabase's built-in admin.inviteUserByEmail —
// no plain-text password ever leaves the server. If the user already exists
// (say, they are already a client of another salon), we skip the invite and
// just add the role.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type AllowedRole = "salon_admin" | "manager" | "master";

/**
 * Куда Supabase вернёт человека по ссылке из письма-приглашения.
 *
 * ЧТО БЫЛО СЛОМАНО. inviteUserByEmail вызывался без redirectTo, и Supabase подставлял Site URL
 * проекта — то есть посадочную страницу. Сотрудник получал письмо «вас пригласили», нажимал
 * ссылку и попадал на рекламную страницу Qabyl, где ему предлагали зарегистрироваться заново.
 * Пароль он при этом так и не задавал, а значит войти не мог в принципе. Приглашение сотрудников
 * не работало ни разу.
 *
 * ПОЧЕМУ АДРЕС ПРОВЕРЯЕТСЯ ПО СПИСКУ. Его присылает браузер, а это значит — кто угодно. Без
 * проверки открытый редирект: письмо уходит с нашего домена и уводит человека на чужой сайт,
 * где у него спросят пароль. Supabase проверяет адрес и со своей стороны, но полагаться на
 * настройку в чужой панели там, где можно проверить у себя, не стоит.
 */
const ALLOWED_ORIGINS = [
  "https://qabyl.com",
  "https://www.qabyl.com",
  "http://localhost:8080",
  "http://localhost:3000",
];

function inviteRedirectTo(origin: string | null | undefined): string {
  const base = origin && ALLOWED_ORIGINS.includes(origin) ? origin : "https://qabyl.com";
  // `mode=invite` включает на экране входа вид «придумайте пароль» с нужными словами:
  // человека не регистрируют заново, его заводят в уже существующий салон.
  return `${base}/auth?mode=invite`;
}
const ROLE_LABELS: Record<AllowedRole, string> = {
  salon_admin: "Владелец / главный администратор",
  manager: "Администратор / регистратор",
  master: "Врач / мастер",
};

/**
 * Кто и что может делать с доступами салона.
 *
 * ЧТО ИЗМЕНИЛОСЬ. Раньше функция отвечала «да/нет», и «да» означало владельца или платформу.
 * Администратор на ресепшене не мог завести доступ даже мастеру — а именно он и занимается
 * этим в реальном салоне: владелица приходит к вечеру, а мастера выходят с утра.
 *
 * Теперь возвращается УРОВЕНЬ, и он решает, какую роль можно выдать:
 *   owner   — владелец салона или платформа: любые роли, включая совладельца;
 *   manager — администратор: только мастера. Назначить совладельца или второго администратора
 *             он не может — иначе роль с ограниченными правами умеет выдавать себе любые.
 */
type ActorLevel = "owner" | "manager";

async function actorLevel(userId: string, salonId: string): Promise<ActorLevel> {
  const mod = await import("@/integrations/supabase/client.server");
  const supabaseAdmin = mod.supabaseAdmin as any;
  const { data: roles, error } = await supabaseAdmin
    .from("user_roles")
    .select("role, salon_id")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const list = roles ?? [];
  const owner = list.some(
    (r: any) => r.role === "super_admin" || (r.role === "salon_admin" && r.salon_id === salonId),
  );
  if (owner) return "owner";
  const manager = list.some((r: any) => r.role === "manager" && r.salon_id === salonId);
  if (manager) return "manager";
  throw new Error("Доступами салона управляет владелец или администратор");
}

async function assertCanManageEmployees(userId: string, salonId: string) {
  await actorLevel(userId, salonId);
}

/**
 * Пароль, который можно продиктовать голосом.
 *
 * Восемь цифр. Не буквы и не символы: пароль передают вслух или в голосовом сообщении, и на
 * «заглавная эл, потом единица» уходит больше времени, чем на всю остальную настройку. Восемь
 * цифр — это 100 миллионов вариантов, чего с лихвой хватает для входа, который защищён ещё и
 * почтой, и который владелец в любой момент отзывает одной кнопкой.
 *
 * Генерация через crypto: Math.random для паролей не годится — он предсказуем.
 */
function generateNumericPassword(): string {
  const bytes = new Uint32Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => String(n % 10)).join("");
}

async function audit(params: {
  salonId: string;
  actorId: string;
  action: string;
  subjectUser?: string | null;
  subjectMaster?: string | null;
  before?: unknown;
  after?: unknown;
}) {
  const mod = await import("@/integrations/supabase/client.server");
  const supabaseAdmin = mod.supabaseAdmin as any;
  await supabaseAdmin.from("rbac_audit").insert({
    salon_id: params.salonId,
    actor_id: params.actorId,
    action: params.action,
    subject_user: params.subjectUser ?? null,
    subject_master: params.subjectMaster ?? null,
    before: params.before ?? null,
    after: params.after ?? null,
  });
}

/**
 * Найти аккаунт по адресу.
 *
 * Перебор страниц listUsers — единственное, что даёт админский API: поиска по email в нём нет.
 * На тысяче аккаунтов это одна страница, дальше растёт линейно; когда станет дорого, здесь
 * появится запрос к auth.users через service-role, а не ещё один цикл.
 */
async function findUserByEmail(supabaseAdmin: any, email: string): Promise<{ id: string } | null> {
  const needle = email.trim().toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    const users = list?.users ?? [];
    const hit = users.find(
      (u: { id: string; email?: string }) => u.email?.toLowerCase() === needle,
    );
    if (hit) return { id: hit.id };
    if (users.length < 1000) return null;
  }
  return null;
}

/**
 * Почему письмо не ушло — словами владельца салона и с выходом из положения.
 *
 * Самая частая причина — предел встроенной почтовой службы Supabase. Она рассчитана на проверку,
 * а не на работу, и молча упирается в потолок. Владельцу в этот момент нужно не название ошибки,
 * а понимание, что делать прямо сейчас: у него есть логин с паролем вручную.
 */
function humanAuthText(raw: string): string {
  const m = (raw || "").toLowerCase();
  if (m.includes("already been registered") || m.includes("already registered")) {
    return "Аккаунт с такой почтой уже есть — он входит своей почтой и своим паролем.";
  }
  if (m.includes("password")) return "Не удалось задать пароль — попробуйте ещё раз.";
  if (m.includes("email")) return "Проверьте, правильно ли написан адрес.";
  return raw;
}

function mailErrorText(raw: string): string {
  const m = (raw || "").toLowerCase();
  // Supabase не даёт слать одному адресу чаще, чем раз в N секунд (Minimum interval per user,
  // по умолчанию 60). Нажать «Отправить ссылку» дважды подряд — самое естественное действие
  // человека, который не увидел письма, и упираться в это он будет постоянно.
  const secs = /after (\d+) seconds?/.exec(m)?.[1];
  if (secs || m.includes("for security purposes")) {
    return `Письмо этому адресу уже отправлено. Следующее можно через ${secs ?? "минуту"}${secs ? " сек." : ""} — или выдайте пароль прямо сейчас, способ «Выдать пароль» в форме выше.`;
  }
  if (m.includes("rate limit") || m.includes("too many") || m.includes("429")) {
    return "Достигнут предел писем за час. Отправьте позже — или выдайте пароль прямо сейчас, способ «Выдать пароль» в форме выше.";
  }
  if (m.includes("smtp") || m.includes("send") || m.includes("mail")) {
    return "Письмо не отправилось — почтовая служба недоступна. Выдайте пароль прямо сейчас (способ «Выдать пароль» в форме выше), а мы разберёмся с отправкой.";
  }
  if (m.includes("invalid") && m.includes("email")) return "Проверьте, правильно ли написан адрес.";
  return `Письмо не отправилось: ${raw}`;
}

// ─────────────────────────── invite / list / revoke ────────────────────────

export const inviteEmployee = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        email: z.string().email().max(255),
        role: z.enum(["salon_admin", "manager", "master"]),
        // For master role, the branch is required.
        branchId: z.string().uuid().nullable().optional(),
        // Optional: pre-link to an existing masters row (must belong to the salon).
        masterId: z.string().uuid().nullable().optional(),
        /** Адрес кабинета, из которого зовут. Нужен, чтобы письмо вело в него, а не на главную. */
        origin: z.string().max(200).nullable().optional(),
        /**
         * Как выдать доступ.
         *   email    — письмо со ссылкой, человек сам придумывает пароль;
         *   password — заводим аккаунт сразу и показываем пароль один раз.
         *
         * Второй способ нужен не как запасной, а как основной для половины салонов: у мастера
         * часто нет почты, которой он пользуется, а встроенная почтовая служба вдобавок
         * упирается в предел писем в час. Пароль работает всегда и сразу.
         */
        method: z.enum(["email", "password"]).default("email"),
      })
      .refine((v) => v.role !== "master" || !!v.branchId, {
        message: "branchId required for master role",
        path: ["branchId"],
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const level = await actorLevel(context.userId, data.salonId);
    // Администратор заводит только мастеров. Дать ему право назначать совладельцев значит
    // сделать ограничение его роли необязательным: достаточно назначить совладельцем себя.
    if (level === "manager" && data.role !== "master") {
      throw new Error("Администратор может добавлять только мастеров");
    }
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;

    // 1) Завести аккаунт или найти существующий — и ЧЕСТНО сказать, ушло ли письмо.
    //
    // ЧТО БЫЛО СЛОМАНО (логи auth за 12.09). За сутки было два вызова /invite: один вернул 200
    // и отправил письмо, второй — 422 «A user with this email address has already been
    // registered», письма не было вовсе. Прежний код глотал эту ошибку, находил человека
    // перебором, выдавал роль и возвращал `invited: false`, а экран показывал «Доступ выдан».
    // С точки зрения владельца салона это «приглашение отправлено» — и он ждал, пока сотрудник
    // зайдёт. Сотрудник не получал ничего и не знал, что его куда-то позвали.
    //
    // Такой случай — не редкость, а норма: человек уже пробовал Qabyl, или его зовут во второй
    // салон, или владелец нажал «Пригласить» дважды. Дальше по коду `outcome` доезжает до экрана,
    // и тот говорит разными словами про «письмо ушло» и «письма не было».
    let userId: string | null = null;
    let outcome: "invited" | "already_registered" | "password" = "invited";
    let password: string | null = null;

    const existing = await findUserByEmail(supabaseAdmin, data.email);
    if (existing) {
      userId = existing.id;
      outcome = "already_registered";
    } else if (data.method === "password") {
      password = generateNumericPassword();
      // email_confirm: true — подтверждать почту нечем и незачем: адрес мог быть выдуман
      // владельцем как имя для входа, письма туда не ходят.
      const created = await supabaseAdmin.auth.admin.createUser({
        email: data.email,
        password,
        email_confirm: true,
      });
      if (created.error) throw new Error(humanAuthText(created.error.message));
      userId = created.data.user!.id;
      outcome = "password";
    } else {
      const inviteResult = await supabaseAdmin.auth.admin.inviteUserByEmail(data.email, {
        redirectTo: inviteRedirectTo(data.origin),
      });
      if (inviteResult.error) {
        // Гонка: аккаунт завели между проверкой и приглашением. Всё остальное — настоящая
        // поломка отправки (лимит писем, отказ SMTP), и молчать о ней нельзя: владелец должен
        // знать, что письма не будет, чтобы дать доступ вторым способом.
        const again = await findUserByEmail(supabaseAdmin, data.email);
        if (!again) throw new Error(mailErrorText(inviteResult.error.message));
        userId = again.id;
        outcome = "already_registered";
      } else {
        userId = inviteResult.data.user!.id;
        outcome = "invited";
      }
    }

    // 2) Assign role (idempotent — dedup with 'duplicate' ignore).
    const rolePayload: any = {
      user_id: userId,
      role: data.role,
      salon_id: data.salonId,
    };
    if (data.role === "master") rolePayload.branch_id = data.branchId;
    const { error: roleErr } = await supabaseAdmin.from("user_roles").insert(rolePayload);
    if (roleErr && !roleErr.message.includes("duplicate")) throw new Error(roleErr.message);

    // 3) Optional master-profile link.
    if (data.masterId) {
      const { data: mrow, error: mErr } = await supabaseAdmin
        .from("masters")
        .select("id, salon_id, user_id")
        .eq("id", data.masterId)
        .maybeSingle();
      if (mErr) throw new Error(mErr.message);
      if (!mrow) throw new Error("Master not found");
      if ((mrow as any).salon_id !== data.salonId)
        throw new Error("Master belongs to a different salon");
      if ((mrow as any).user_id && (mrow as any).user_id !== userId) {
        throw new Error("Master profile is already linked to another user");
      }
      const { error: linkErr } = await supabaseAdmin
        .from("masters")
        .update({ user_id: userId })
        .eq("id", data.masterId);
      if (linkErr) throw new Error(linkErr.message);
    }

    await audit({
      salonId: data.salonId,
      actorId: context.userId,
      action: outcome === "invited" ? "invite" : "assign_role",
      subjectUser: userId,
      subjectMaster: data.masterId ?? null,
      after: { role: data.role, email: data.email, outcome },
    });

    return {
      ok: true,
      userId,
      /** Ушло ли письмо. Единственное, что отличает «сотрудник узнает» от «не узнает». */
      emailSent: outcome === "invited",
      outcome,
      invited: outcome === "invited",
      /** Показывается ровно один раз и нигде не сохраняется. */
      password,
      roleLabel: ROLE_LABELS[data.role],
    };
  });

/**
 * Выдать сотруднику новый пароль.
 *
 * ЗАЧЕМ. Пароль показывается один раз, и «забыл» — это норма, а не исключение. Без этой кнопки
 * единственный выход был отозвать доступ и завести человека заново, потеряв привязку к профилю
 * мастера. Работает и для тех, кого заводили письмом: администратору всё равно, как аккаунт
 * появился, ему нужно, чтобы человек вошёл.
 */
export const resetEmployeePassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ salonId: z.string().uuid(), userId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const level = await actorLevel(context.userId, data.salonId);
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;

    const { data: roles } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", data.userId)
      .eq("salon_id", data.salonId);
    const list = (roles ?? []).map((r: any) => r.role as string);
    if (!list.length) throw new Error("У этого человека нет доступа к салону");
    // Администратор меняет пароль только мастерам — иначе он сменит пароль владельцу и войдёт
    // под ним.
    if (level === "manager" && !list.every((r: string) => r === "master")) {
      throw new Error("Администратор может менять пароль только мастерам");
    }

    const password = generateNumericPassword();
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, { password });
    if (error) throw new Error(humanAuthText(error.message));

    await audit({
      salonId: data.salonId,
      actorId: context.userId,
      action: "reset_password",
      subjectUser: data.userId,
    });

    return { ok: true, password };
  });

/**
 * Отправить человеку ссылку для входа ещё раз.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ ПОВТОРНЫЙ inviteUserByEmail. Повторное приглашение существующему
 * аккаунту Supabase отклоняет с 422 — тем самым, из-за которого письма и не приходили. Поэтому
 * повтор идёт через письмо восстановления пароля: оно уходит любому существующему аккаунту,
 * приводит на наш же экран и заканчивается тем же самым — человек задаёт пароль и попадает в
 * кабинет. Для сотрудника разницы нет; для нас это разница между «работает» и «422».
 *
 * Письмо идёт через почтовую службу Supabase, и у неё есть предел. Если предел исчерпан, владелец
 * узнаёт об этом текстом, а не тишиной: у него есть второй путь — логин и пароль вручную.
 */
export const resendEmployeeInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        userId: z.string().uuid(),
        origin: z.string().max(200).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageEmployees(context.userId, data.salonId);
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;

    // Человек должен иметь доступ именно к ЭТОМУ салону: иначе кнопка «отправить ещё раз»
    // превращается в рассылку писем на любой адрес из базы.
    const { data: roles } = await supabaseAdmin
      .from("user_roles")
      .select("id")
      .eq("user_id", data.userId)
      .eq("salon_id", data.salonId)
      .limit(1);
    if (!roles?.length) throw new Error("У этого человека нет доступа к салону");

    const { data: got } = await supabaseAdmin.auth.admin.getUserById(data.userId);
    const email = got?.user?.email as string | undefined;
    if (!email) throw new Error("У аккаунта нет почты — отправить письмо некуда");

    const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
      redirectTo: inviteRedirectTo(data.origin),
    });
    if (error) throw new Error(mailErrorText(error.message));

    await audit({
      salonId: data.salonId,
      actorId: context.userId,
      action: "resend_invite",
      subjectUser: data.userId,
      after: { email },
    });

    return { ok: true, email };
  });

export const listSalonEmployees = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ salonId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertCanManageEmployees(context.userId, data.salonId);
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;

    const { data: roles, error } = await supabaseAdmin
      .from("user_roles")
      .select("id, user_id, role, branch_id, created_at")
      .eq("salon_id", data.salonId)
      .in("role", ["salon_admin", "manager", "master"]);
    if (error) throw new Error(error.message);

    // Batch-fetch masters (which one is linked to which user).
    const userIds = Array.from(new Set((roles ?? []).map((r: any) => r.user_id)));
    const { data: masters } = await supabaseAdmin
      .from("masters")
      .select("id, name, user_id, branch_id")
      .eq("salon_id", data.salonId)
      .in("user_id", userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"]);

    // Почта — точечно по каждому известному идентификатору, а не перебором всех пользователей.
    //
    // Здесь стоял listUsers по 1000 на страницу в цикле до конца списка. У салона из трёх
    // сотрудников это уже означало выгрузку ВСЕХ аккаунтов платформы на каждое открытие вкладки, и
    // стоимость росла с числом клиентов Qabyl, а не с размером салона. На сотне салонов такой
    // экран открывался бы секундами.
    const found = await Promise.all(
      userIds.map(async (id) => {
        const { data } = await supabaseAdmin.auth.admin.getUserById(id);
        return [
          id,
          {
            email: data?.user?.email as string | undefined,
            // Заходил ли человек хоть раз. Без этого «доступ выдан» и «человек так и не вошёл»
            // на экране выглядят одинаково, и владелец неделю ждёт того, кто ничего не получал.
            signedIn: Boolean(data?.user?.last_sign_in_at),
          },
        ] as const;
      }),
    );
    const emailById = new Map(found);
    const masterByUserId = new Map((masters ?? []).map((m: any) => [m.user_id, m] as const));

    return (roles ?? []).map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      email: emailById.get(r.user_id)?.email ?? "(неизвестно)",
      signedIn: emailById.get(r.user_id)?.signedIn ?? false,
      role: r.role as AllowedRole,
      roleLabel: ROLE_LABELS[r.role as AllowedRole] ?? r.role,
      branchId: r.branch_id ?? null,
      linkedMaster: masterByUserId.get(r.user_id) ?? null,
      createdAt: r.created_at,
    }));
  });

export const revokeEmployeeAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        userId: z.string().uuid(),
        // If true, also unlink from any masters row in this salon.
        unlinkMaster: z.boolean().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageEmployees(context.userId, data.salonId);
    if (data.userId === context.userId) {
      throw new Error("Нельзя отозвать доступ у самого себя");
    }
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;

    const { data: existing } = await supabaseAdmin
      .from("user_roles")
      .select("id, role")
      .eq("user_id", data.userId)
      .eq("salon_id", data.salonId)
      .in("role", ["salon_admin", "manager", "master"]);

    const { error: delErr } = await supabaseAdmin
      .from("user_roles")
      .delete()
      .eq("user_id", data.userId)
      .eq("salon_id", data.salonId)
      .in("role", ["salon_admin", "manager", "master"]);
    if (delErr) throw new Error(delErr.message);

    if (data.unlinkMaster) {
      await supabaseAdmin
        .from("masters")
        .update({ user_id: null })
        .eq("salon_id", data.salonId)
        .eq("user_id", data.userId);
    }

    await audit({
      salonId: data.salonId,
      actorId: context.userId,
      action: "revoke",
      subjectUser: data.userId,
      before: { roles: existing ?? [] },
    });

    return { ok: true, removedCount: existing?.length ?? 0 };
  });

export const linkMasterToUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        salonId: z.string().uuid(),
        masterId: z.string().uuid(),
        // Pass null to unlink.
        userId: z.string().uuid().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageEmployees(context.userId, data.salonId);
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;

    const { data: mrow, error } = await supabaseAdmin
      .from("masters")
      .select("id, salon_id, user_id")
      .eq("id", data.masterId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!mrow) throw new Error("Master not found");
    if ((mrow as any).salon_id !== data.salonId)
      throw new Error("Master belongs to a different salon");

    if (data.userId) {
      // Reject double-linking: the target user must not already own a different master.
      const { data: other } = await supabaseAdmin
        .from("masters")
        .select("id")
        .eq("user_id", data.userId)
        .neq("id", data.masterId)
        .maybeSingle();
      if (other) throw new Error("Этот пользователь уже связан с другим профилем мастера");
    }

    const { error: updErr } = await supabaseAdmin
      .from("masters")
      .update({ user_id: data.userId })
      .eq("id", data.masterId);
    if (updErr) throw new Error(updErr.message);

    await audit({
      salonId: data.salonId,
      actorId: context.userId,
      action: "link_master",
      subjectUser: data.userId ?? null,
      subjectMaster: data.masterId,
      before: { user_id: (mrow as any).user_id ?? null },
      after: { user_id: data.userId },
    });

    return { ok: true };
  });

// Staff isolation toggle for the salon. Only salon_admin / super_admin.
export const setStaffIsolation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ salonId: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageEmployees(context.userId, data.salonId);
    const mod = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = mod.supabaseAdmin as any;
    const { data: before } = await supabaseAdmin
      .from("salons")
      .select("staff_isolation")
      .eq("id", data.salonId)
      .maybeSingle();

    // ЗАПИСЬ ИДЁТ КЛИЕНТОМ ПОЛЬЗОВАТЕЛЯ, А НЕ service-role — и это не мелочь.
    //
    // На salons висит триггер guard_salon_staff_isolation: он требует, чтобы auth.uid() был
    // владельцем салона. Под service-role auth.uid() = NULL, поэтому триггер отказывал ВСЕМ,
    // включая владельца, и переключатель не работал ни разу за всё время. Наружу это выходило
    // английской строкой поверх русского интерфейса.
    //
    // Проверка прав при этом не ослабла, а усилилась: assertCanManageEmployees выше и триггер в
    // базе теперь проверяют одно и то же с двух сторон.
    const { error } = await (context.supabase as any)
      .from("salons")
      .update({ staff_isolation: data.enabled })
      .eq("id", data.salonId);
    if (error) throw new Error(error.message);
    await audit({
      salonId: data.salonId,
      actorId: context.userId,
      action: "toggle_isolation",
      before: { staff_isolation: (before as any)?.staff_isolation ?? false },
      after: { staff_isolation: data.enabled },
    });
    return { ok: true };
  });
