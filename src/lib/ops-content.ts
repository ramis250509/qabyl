// Контент-план Миры без сети и базы: разбор ответа модели, запасной план и форматирование.
//
// ЗАЧЕМ ОТДЕЛЬНО. Мира — первый агент, который что-то ПРИДУМЫВАЕТ, а не считает. На входе у неё
// текст от модели, а он приходит в любом виде: с ```json, с лишними полями, обрезанный на середине.
// Разбор такого текста — то место, где всё ломается молча, поэтому он живёт здесь и проверяется
// тестами, а не выясняется в Telegram в понедельник утром.
//
// Запасной план — не заглушка, а полноценный минимум: без ключа Gemini или при сбое Мира всё равно
// приходит с планом, собранным из фактов о платформе. Молчащий агент бесполезнее скучного.

export type PlatformFacts = {
  salons: number;
  newSalons30d: number;
  industries: string[];
  bookings7d: number;
  aiBookings7d: number;
  topServices: string[];
  noShowRate30d: number;
};

export type ContentPost = {
  /** «Пост», «Сторис», «Рилс» — формат словами, а не типом из API. */
  format: string;
  hook: string;
  caption: string;
  cta: string;
};

export type PromoIdea = {
  title: string;
  audience: string;
  offer: string;
  why: string;
};

export type ContentPlan = {
  posts: ContentPost[];
  promo: PromoIdea | null;
};

const MAX_POSTS = 3;
const LIMITS = {
  format: 24,
  hook: 120,
  caption: 700,
  cta: 80,
  title: 80,
  audience: 120,
  offer: 200,
  why: 200,
};

function str(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Разбор ответа модели. null — если не набралось ни одного годного поста: вызывающий тогда берёт
 * запасной план. Частично испорченный ответ не выбрасывается целиком — два хороших поста из трёх
 * это всё ещё план.
 */
export function parseContentPlan(raw: string): ContentPlan | null {
  const cleaned = String(raw ?? "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  // Модель иногда добавляет фразу до или после JSON — берём объект от первой { до последней }.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }

  const posts: ContentPost[] = [];
  for (const p of Array.isArray(parsed?.posts) ? parsed.posts : []) {
    const hook = str(p?.hook, LIMITS.hook);
    const caption = str(p?.caption, LIMITS.caption);
    if (!hook || !caption) continue;
    posts.push({
      format: str(p?.format, LIMITS.format) || "Пост",
      hook,
      caption,
      cta: str(p?.cta, LIMITS.cta) || "Написать нам",
    });
    if (posts.length === MAX_POSTS) break;
  }
  if (posts.length === 0) return null;

  const pr = parsed?.promo;
  const title = str(pr?.title, LIMITS.title);
  const offer = str(pr?.offer, LIMITS.offer);
  const promo: PromoIdea | null =
    title && offer
      ? {
          title,
          audience: str(pr?.audience, LIMITS.audience) || "Салоны красоты",
          offer,
          why: str(pr?.why, LIMITS.why),
        }
      : null;

  return { posts, promo };
}

/** План из одних фактов — когда модель недоступна. */
export function fallbackContentPlan(f: PlatformFacts): ContentPlan {
  const niche = f.industries[0] ?? "салонов красоты";
  const posts: ContentPost[] = [
    {
      format: "Пост",
      hook: `${f.aiBookings7d} записей за неделю оформил ассистент — без единого звонка`,
      caption:
        `За последние 7 дней салоны на Qabyl получили ${f.bookings7d} записей, из них ${f.aiBookings7d} ` +
        `ассистент оформил сам, пока владельцы работали с клиентами. Он отвечает в WhatsApp круглосуточно: ` +
        `подбирает время, записывает, напоминает о визите.`,
      cta: "Напишите нам — подключим ваш салон за вечер",
    },
    {
      format: "Сторис",
      hook: "Клиент пишет в 23:40. Кто ответит?",
      caption:
        "Опрос из трёх вариантов: отвечаю сам, отвечает администратор, теряю клиента. " +
        "Во второй сторис — как то же самое делает ассистент, пока вы спите.",
      cta: "Свайп вверх",
    },
    {
      format: "Рилс",
      hook: `Неявки — ${f.noShowRate30d}% записей. Это пустое кресло в кассе`,
      caption:
        `Короткое видео о напоминании за два часа: как одно сообщение возвращает клиента, который ` +
        `забыл о визите. На платформе ${f.salons} ${f.salons === 1 ? "салон" : "салонов"}, и у тех, ` +
        `кто включил напоминания, пустых окон меньше.`,
      cta: "Подключить напоминания",
    },
  ];
  const promo: PromoIdea | null =
    f.newSalons30d === 0
      ? {
          title: "Первый месяц бесплатно",
          audience: `Владельцы ${niche} в Бишкеке`,
          offer: "30 дней бесплатно на тарифе Start, подключение за вечер, карта не нужна",
          why: "За 30 дней новых салонов не пришло — нужен вход без риска для владельца",
        }
      : null;
  return { posts, promo };
}

export function formatContentPlan(plan: ContentPlan, f: PlatformFacts): string {
  const parts: string[] = [
    "📣 <b>Мира: план на неделю</b>",
    "",
    `<i>Из чего исходила: ${f.salons} ${f.salons === 1 ? "салон" : "салонов"} на платформе, ` +
      `${f.bookings7d} записей за 7 дней (ассистент — ${f.aiBookings7d}), неявки ${f.noShowRate30d}%.</i>`,
    "",
  ];
  plan.posts.forEach((p, i) => {
    parts.push(`<b>${i + 1}. ${p.format}: ${p.hook}</b>`, p.caption, `👉 ${p.cta}`, "");
  });
  if (plan.promo) {
    parts.push(
      "🎯 <b>Промо</b>",
      `<b>${plan.promo.title}</b>`,
      `Кому: ${plan.promo.audience}`,
      `Что предлагаем: ${plan.promo.offer}`,
    );
    if (plan.promo.why) parts.push(`Зачем: ${plan.promo.why}`);
    parts.push("");
  }
  parts.push("Одобрите — задачи появятся на доске, и Айдар узнает про промо.");
  return parts.filter((l) => l !== "").join("\n");
}

/** Действие, которое исполнится после «Одобрить». Хранится на сервере, не в кнопке. */
export function contentPlanAction(plan: ContentPlan): Record<string, unknown> {
  return {
    type: "content_plan",
    // Текст поста едет вместе с планом: именно его потом публикуем, и переспрашивать модель
    // второй раз значило бы получить другой текст, чем тот, который владелец одобрил.
    posts: plan.posts.map((p) => ({
      format: p.format,
      hook: p.hook,
      caption: p.caption,
      cta: p.cta,
    })),
    promo: plan.promo ? { title: plan.promo.title, offer: plan.promo.offer } : null,
  };
}

/**
 * Промпт для картинки к посту.
 *
 * ДВА ПРАВИЛА, которые стоили бы денег при каждой ошибке. Первое: никакого текста на изображении —
 * модели пишут его с ошибками, а пост с кривой надписью нельзя выложить и нельзя починить, только
 * сгенерировать заново. Второе: снимок салона, а не коллаж из стоков — лента бьюти-аккаунта
 * состоит из живых кадров, и сгенерированная открытка видна сразу.
 */
export function imagePromptForPost(post: {
  format: string;
  hook: string;
  caption: string;
}): string {
  const vertical = /сторис|рилс/i.test(post.format);
  return [
    "Фотореалистичный кадр для соцсетей бьюти-бизнеса в Центральной Азии.",
    `Настроение задаёт мысль: «${post.hook}».`,
    "Салон красоты: тёплый дневной свет, мягкие тени, естественные цвета кожи, аккуратный интерьер.",
    "Люди выглядят как местные жительницы 25-45 лет, без глянцевой ретуши.",
    vertical ? "Вертикальный кадр, композиция под телефон." : "Горизонтальный или квадратный кадр.",
    "БЕЗ текста, надписей, логотипов и водяных знаков в кадре.",
    "Без коллажей, без рамок, без инфографики.",
  ].join(" ");
}

const HASHTAGS = ["#бишкек", "#салонкрасотыбишкек", "#записьонлайн", "#бьютибизнес", "#qabyl"];

/**
 * Задание на пост: текст, промпт для картинки и как это снять.
 *
 * Владелец копирует промпт в ChatGPT и публикует сам, поэтому всё, что ему нужно, лежит в одном
 * сообщении и в том порядке, в каком он будет это делать: сначала картинка, потом подпись.
 * Промпт отдаётся отдельным блоком — в Telegram по нему нажимают и он копируется целиком.
 */
export function formatPostBrief(post: ContentPost): string {
  const vertical = /сторис|рилс/i.test(post.format);
  const caption = post.cta ? `${post.caption}\n\n${post.cta}` : post.caption;
  return [
    `📣 <b>${post.format}: ${post.hook}</b>`,
    "",
    "<b>1. Промпт для картинки</b> — нажмите, чтобы скопировать:",
    `<code>${escapeForTelegram(imagePromptForPost(post))}</code>`,
    "",
    "<b>2. Как снять</b>",
    vertical
      ? "Вертикаль 9:16, крупный план, движение в первые 2 секунды."
      : "Квадрат 1:1 или 4:5, главный объект по центру, воздух по краям.",
    "Без текста на самой картинке — подпись всё скажет.",
    "",
    "<b>3. Подпись</b> — нажмите, чтобы скопировать:",
    `<code>${escapeForTelegram(caption)}</code>`,
    "",
    `<b>4. Хештеги</b>`,
    `<code>${HASHTAGS.join(" ")}</code>`,
    "",
    "Опубликовали — закройте задачу: /done ",
  ].join("\n");
}

/** В HTML-режиме Telegram эти три символа ломают разметку сообщения. */
export function escapeForTelegram(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
