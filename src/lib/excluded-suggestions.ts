// «Кому ассистент отвечает зря» — оценка одного контакта по его переписке.
//
// ЗАЧЕМ. «Контакты без Админа» пополнялись руками, по номеру за раз. У Lashes Nurzhan за месяц
// 448 чатов, записались 8, а в списке исключений было 12 номеров: владелица не помнит всех, кому
// ассистент пишет впустую, — родных, подруг, поставщиков. Каждый такой ответ — платное сообщение.
//
// ПОЧЕМУ ПРАВИЛА, А НЕ ИИ. Просмотр сотен переписок нейросетью стоит денег при каждом нажатии и
// ошибается непредсказуемо. Правила бесплатны, мгновенны и объяснимы: рядом с каждым кандидатом
// показано, почему он попал в список, и владелец решает сам.
//
// ПОЧЕМУ ТОЛЬКО ПРЕДЛОЖЕНИЕ. Промах в сторону «не клиент» стоит салону клиента, который написал и
// не получил ответа. Поэтому любой признак записи или разговора об услугах снимает контакт из
// кандидатов целиком, а добавление в исключения всегда подтверждает человек.

import { plural } from "@/lib/billing-logic";

export type ContactSignals = {
  /** Только цифры. */
  phone: string;
  name: string | null;
  /** Тексты сообщений контакта, самые свежие первыми. */
  inboundTexts: string[];
  /** Всего входящих, включая фото и голосовые. */
  inboundCount: number;
  /** Ответы ассистента. */
  aiReplies: number;
  /** Сообщения, которые владелец написал сам с телефона. */
  ownerReplies: number;
  /** Записывался ли когда-нибудь. */
  everBooked: boolean;
  /** Номер салона, филиала или владельца. */
  isSalonNumber: boolean;
};

export type ContactVerdict = {
  score: number;
  confidence: "high" | "medium";
  reasons: string[];
};

/** Слова о записи и услугах — русский и кыргызский. Любое из них = это клиент или лид. */
export const BUSINESS_STEMS = [
  "запис",
  "запиш",
  "свобод",
  "окошк",
  "цена",
  "цены",
  "стоим",
  "скольк",
  "прайс",
  "скидк",
  "акци",
  "мастер",
  "услуг",
  "салон",
  "адрес",
  "курс",
  "обучен",
  "урок",
  "бронь",
  "брониров",
  "перенес",
  "отмен",
  "наращ",
  "ресниц",
  "бров",
  "маникюр",
  "педикюр",
  "стриж",
  "окраш",
  "ламин",
  "депил",
  "массаж",
  "чистк",
  "коррекц",
  "жазыл",
  "жазып",
  "канча",
  "баасы",
  "бош убак",
  "дарек",
  "кирпик",
  "окуу",
  "сабак",
];

/** Приметы личной переписки. Сами по себе ничего не решают — только добавляют уверенности. */
const PERSONAL_STEMS = [
  "как дела",
  "кандайсы",
  "кайдасы",
  "где ты",
  "скучаю",
  "сагындым",
  "люблю",
  "жаным",
  "домой",
  "үйгө",
  "уйго",
  "покушал",
  "мама",
  "папа",
  "апам",
  "атам",
  "балам",
  "сестрен",
  "братан",
];

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е");
}

/**
 * Основы слов из названий услуг салона: «Наращивание ресниц 2D» → «наращ», «ресни».
 * Пять букв — достаточно, чтобы поймать падежи, и мало, чтобы не цеплять случайные слова.
 */
export function stemsFromServiceNames(names: string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    for (const word of normalizeText(name).split(/[^a-zа-яөүң]+/i)) {
      if (word.length >= 5) out.add(word.slice(0, 5));
    }
  }
  return [...out];
}

/** Оценка контакта. null — не предлагать. */
export function assessContact(
  s: ContactSignals,
  serviceStems: string[] = [],
): ContactVerdict | null {
  if (s.isSalonNumber) {
    return {
      score: 100,
      confidence: "high",
      reasons: ["Это номер салона, филиала или владельца"],
    };
  }
  if (s.everBooked) return null;

  const text = normalizeText(s.inboundTexts.join("\n"));
  if ([...BUSINESS_STEMS, ...serviceStems].some((w) => w && text.includes(w))) return null;

  let score = 0;
  const reasons: string[] = [];

  if (s.inboundCount >= 3) {
    score += 40;
    reasons.push(
      `${s.inboundCount} ${plural(s.inboundCount, "сообщение", "сообщения", "сообщений")} — ни слова о записи или услугах, записей не было`,
    );
    if (s.inboundCount >= 8) score += 15;
  } else if (s.inboundCount > 0) {
    score += 15;
  }

  if (s.ownerReplies > 0) {
    score += s.ownerReplies >= 5 ? 45 : 35;
    reasons.push("Вы сами переписывались в этом чате с телефона");
  }

  if (PERSONAL_STEMS.some((w) => text.includes(w))) {
    score += 20;
    reasons.push("Похоже на личную переписку");
  }

  if (score < 50) return null;
  return {
    score: Math.min(score, 99),
    confidence: score >= 75 && s.ownerReplies > 0 ? "high" : "medium",
    reasons,
  };
}
