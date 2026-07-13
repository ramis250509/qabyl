import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Свежий анонимный клиент только для проверки текущего пароля (signInWithPassword).
// Отдельный инстанс с persistSession:false — не трогает сессию пользователя.
function anonClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase public env vars");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
}

function emailFromClaims(claims: any): string {
  const email = claims?.email;
  if (typeof email !== "string" || !email) {
    throw new Error("Не удалось определить текущий email аккаунта");
  }
  return email;
}

// Авторитетный текущий email аккаунта. В проде берём из admin API (всегда
// актуальный — важно, если логин уже меняли в этой же сессии и JWT устарел).
// В локальной среде без сервисного ключа admin недоступен — откатываемся на
// email из JWT-claims, чтобы проверка пароля всё равно работала.
async function resolveCurrentEmail(userId: string, claims: any): Promise<string> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (!error && data?.user?.email) return data.user.email;
  } catch {
    // нет сервисного ключа (локальный dev) — падаем на claims
  }
  return emailFromClaims(claims);
}

// Подтверждаем личность владельца сессии, требуя текущий пароль. Защищает от
// смены логина/пароля при угоне сессии (одного bearer-токена недостаточно).
async function verifyPassword(email: string, currentPassword: string): Promise<void> {
  const { error } = await anonClient().auth.signInWithPassword({
    email,
    password: currentPassword,
  });
  if (error) throw new Error("Неверный текущий пароль");
}

export const updateMyPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8, "Пароль должен быть не короче 8 символов").max(72),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const email = await resolveCurrentEmail(context.userId, context.claims);
    await verifyPassword(email, data.currentPassword);
    if (data.newPassword === data.currentPassword) {
      throw new Error("Новый пароль совпадает с текущим");
    }
    const { error } = await supabaseAdmin.auth.admin.updateUserById(context.userId, {
      password: data.newPassword,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateMyLogin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        currentPassword: z.string().min(1),
        newEmail: z.string().email("Некорректный email").max(255),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const currentEmail = await resolveCurrentEmail(context.userId, context.claims);
    await verifyPassword(currentEmail, data.currentPassword);
    const newEmail = data.newEmail.trim().toLowerCase();
    if (newEmail === currentEmail.toLowerCase()) {
      throw new Error("Новый логин совпадает с текущим");
    }
    // email_confirm: true — меняем логин мгновенно, без письма-подтверждения
    // (у мастеров часто системные адреса без реального почтового ящика).
    const { error } = await supabaseAdmin.auth.admin.updateUserById(context.userId, {
      email: newEmail,
      email_confirm: true,
    });
    if (error) {
      // Дружелюбное сообщение для самого частого случая — email уже занят.
      const msg = /already|exist|registered|duplicate/i.test(error.message)
        ? "Этот email уже используется другим аккаунтом"
        : error.message;
      throw new Error(msg);
    }
    return { ok: true, email: newEmail };
  });
