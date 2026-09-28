import { normalizeIndustry, type IndustryKey } from "@/lib/industries";

export interface BusinessVocabulary {
  business: string;
  businessPossessive: string;
  specialist: string;
  specialists: string;
  client: string;
  clients: string;
  service: string;
  services: string;
}

const BEAUTY: BusinessVocabulary = {
  business: "салон",
  businessPossessive: "Мой салон",
  specialist: "мастер",
  specialists: "Мастера",
  client: "клиент",
  clients: "Клиенты",
  service: "услуга",
  services: "Услуги",
};

const MEDICAL: BusinessVocabulary = {
  business: "клиника",
  businessPossessive: "Моя клиника",
  specialist: "специалист",
  specialists: "Специалисты",
  client: "пациент",
  clients: "Пациенты",
  service: "приём",
  services: "Услуги и процедуры",
};

const MEDICAL_INDUSTRIES = new Set<IndustryKey>(["medical", "dental", "cosmetology"]);

/** Единый словарь продуктовой терминологии. Новая vertical добавляется здесь, а не if-ами в UI. */
export function vocabularyFor(industry: unknown): BusinessVocabulary {
  return MEDICAL_INDUSTRIES.has(normalizeIndustry(industry)) ? MEDICAL : BEAUTY;
}

