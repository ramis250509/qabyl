// Публикация в Instagram Qabyl. ТОЛЬКО СЕРВЕР.
//
// НАШ АККАУНТ, НЕ КЛИЕНТСКИЙ. Здесь публикуется только лента самой платформы, поэтому хватает
// стандартного доступа: разрешение на публикацию в СВОЙ аккаунт новой проверки Meta не требует.
// Клиентские аккаунты салонов сюда не попадают и попасть не должны — у них своя история с
// перепиской (ig.$salonId), и публикация от их имени потребовала бы отдельной проверки.
//
// КАК УСТРОЕНА ПУБЛИКАЦИЯ. Два шага: создать контейнер с ссылкой на медиа, затем опубликовать его.
// Instagram САМ СКАЧИВАЕТ файл по ссылке — поэтому картинка лежит в публичном бакете, а не летит
// в запросе. Между шагами контейнер какое-то время «готовится»; для фото это обычно мгновенно, но
// мы всё равно проверяем статус, иначе публикация падает с невнятной ошибкой.
//
// Лимит Meta — 100 публикаций в сутки. Нам до него далеко, но если однажды упрёмся, ошибка придёт
// словами, а не тишиной.

const IG_BASE = "https://graph.instagram.com/v23.0";

export function igPublishConfigured(): boolean {
  return Boolean(process.env.IG_QABYL_TOKEN);
}

function userId(): string {
  return (process.env.IG_QABYL_USER_ID ?? "me").trim() || "me";
}

async function igCall(
  path: string,
  body: Record<string, string>,
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const token = process.env.IG_QABYL_TOKEN ?? "";
  try {
    const res = await fetch(`${IG_BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...body, access_token: token }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) {
      const err = json?.error;
      // Код Meta несут в себе разные починки: 190 — истёк доступ, 9004 — недоступна картинка,
      // 25 — превышен лимит публикаций. Поэтому он передаётся дальше как есть.
      return {
        ok: false,
        error: err
          ? `Instagram ${err.code ?? "?"}: ${String(err.message ?? "").slice(0, 200)}`
          : `Instagram HTTP ${res.status}`,
      };
    }
    return { ok: true, data: json };
  } catch (e: any) {
    return { ok: false, error: `сеть: ${e?.message ?? e}` };
  }
}

async function containerReady(creationId: string): Promise<boolean> {
  const token = process.env.IG_QABYL_TOKEN ?? "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(
        `${IG_BASE}/${creationId}?fields=status_code&access_token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      const json: any = await res.json().catch(() => null);
      const status = String(json?.status_code ?? "");
      if (status === "FINISHED") return true;
      if (status === "ERROR" || status === "EXPIRED") return false;
    } catch {
      /* пробуем ещё раз */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Не дождались — пробуем опубликовать всё равно: для фото контейнер обычно готов сразу, а отказ
  // публикации скажет причину точнее, чем наша догадка.
  return true;
}

export type PublishResult =
  | { ok: true; mediaId: string; permalink: string | null }
  | { ok: false; error: string };

export async function publishImage(opts: {
  imageUrl: string;
  caption: string;
}): Promise<PublishResult> {
  if (!igPublishConfigured()) return { ok: false, error: "доступ к Instagram Qabyl не настроен" };

  const created = await igCall(`${userId()}/media`, {
    image_url: opts.imageUrl,
    caption: opts.caption.slice(0, 2200),
  });
  if (!created.ok) return created;
  const creationId = String(created.data?.id ?? "");
  if (!creationId) return { ok: false, error: "Instagram не вернул контейнер" };

  await containerReady(creationId);

  const published = await igCall(`${userId()}/media_publish`, { creation_id: creationId });
  if (!published.ok) return published;
  const mediaId = String(published.data?.id ?? "");
  if (!mediaId) return { ok: false, error: "Instagram не вернул номер публикации" };

  let permalink: string | null = null;
  try {
    const res = await fetch(
      `${IG_BASE}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(process.env.IG_QABYL_TOKEN ?? "")}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const json: any = await res.json().catch(() => null);
    permalink = json?.permalink ?? null;
  } catch {
    /* ссылка не обязательна: пост уже опубликован */
  }

  return { ok: true, mediaId, permalink };
}
