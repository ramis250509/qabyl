// Per-industry starter service catalogs. One click in the admin ("Услуги" tab) inserts these as
// real `services` rows for the salon, so a new organization gets a near-complete, professionally
// structured price list instead of typing dozens of services by hand.
//
// Quality bar: the "beauty" catalog mirrors the structure, category grouping, naming conventions
// and range/fixed pricing logic of "Эркеайым" (the reference salon named in the product audit) —
// same category set (Ногти / Волосы / Ресницы и брови / Макияж и причёски / Эпиляция / Подология),
// the same "гигиенический vs с покрытием" naming pattern, ranges for work-that-varies-by-volume
// (haircuts, coloring) and fixed prices for standardized services. Every other industry follows
// the same bar, written the way an experienced specialist in THAT field would structure a price
// list — real terminology, realistic durations, and range vs fixed pricing applied for the same
// reason (varies by case → range; standardized → fixed).
//
// Client-safe (no secrets) — imported by the admin UI to run inserts through the normal supabase
// client under the existing "Salon admin manages services" RLS policy. Adding a new industry here
// is purely additive: one array + registering it in SERVICE_CATALOG_TEMPLATES below.

import type { IndustryKey } from "@/lib/industries";

export type CatalogService = {
  category: string;
  name: string;
  duration_min: number;
  duration_max_min?: number; // set only when duration itself varies (rare — most services use a fixed duration_min)
  price: number;
  price_max?: number; // set together with price_type: "range"
  price_type: "fixed" | "range";
  description?: string;
};

// One accent color per category, cycled if a catalog has more categories than colors — keeps the
// calendar/price-list visually organized the way a real salon's color-coding does.
const CATEGORY_COLORS = [
  "#0ea5e9",
  "#f97316",
  "#a855f7",
  "#ec4899",
  "#22c55e",
  "#eab308",
  "#ef4444",
  "#06b6d4",
];

export function colorForCategoryIndex(categories: string[], category: string): string {
  const idx = categories.indexOf(category);
  return CATEGORY_COLORS[idx % CATEGORY_COLORS.length];
}

const beauty: CatalogService[] = [
  // Ногти
  {
    category: "Ногти",
    name: "Маникюр гигиенический",
    duration_min: 40,
    price: 400,
    price_type: "fixed",
  },
  {
    category: "Ногти",
    name: "Маникюр с покрытием (гель-лак)",
    duration_min: 60,
    price: 700,
    price_type: "fixed",
  },
  {
    category: "Ногти",
    name: "Маникюр с дизайном",
    duration_min: 75,
    price: 800,
    price_max: 1200,
    price_type: "range",
    description: "Цена зависит от сложности дизайна",
  },
  {
    category: "Ногти",
    name: "Наращивание ногтей (гель)",
    duration_min: 120,
    price: 1300,
    price_max: 1800,
    price_type: "range",
    description: "Цена зависит от объёма работы",
  },
  { category: "Ногти", name: "Снятие покрытия", duration_min: 20, price: 200, price_type: "fixed" },
  {
    category: "Ногти",
    name: "Педикюр гигиенический",
    duration_min: 50,
    price: 800,
    price_type: "fixed",
  },
  {
    category: "Ногти",
    name: "Педикюр с покрытием",
    duration_min: 70,
    price: 1000,
    price_type: "fixed",
  },
  // Волосы
  {
    category: "Волосы",
    name: "Стрижка женская",
    duration_min: 40,
    price: 500,
    price_max: 1000,
    price_type: "range",
    description: "Цена зависит от длины и густоты волос",
  },
  {
    category: "Волосы",
    name: "Стрижка мужская",
    duration_min: 30,
    price: 400,
    price_type: "fixed",
  },
  {
    category: "Волосы",
    name: "Детская стрижка",
    duration_min: 25,
    price: 350,
    price_type: "fixed",
  },
  {
    category: "Волосы",
    name: "Укладка / причёска",
    duration_min: 40,
    price: 600,
    price_max: 1200,
    price_type: "range",
  },
  {
    category: "Волосы",
    name: "Окрашивание волос в 1 тон",
    duration_min: 90,
    price: 1200,
    price_max: 2500,
    price_type: "range",
    description: "Цена зависит от длины и густоты волос",
  },
  {
    category: "Волосы",
    name: "Сложное окрашивание (мелирование, балаяж)",
    duration_min: 180,
    price: 3000,
    price_max: 8000,
    price_type: "range",
    description: "Цена зависит от объёма работы",
  },
  {
    category: "Волосы",
    name: "Тонирование волос",
    duration_min: 60,
    price: 800,
    price_max: 2000,
    price_type: "range",
  },
  {
    category: "Волосы",
    name: "Кератиновое выпрямление",
    duration_min: 180,
    price: 2500,
    price_max: 6000,
    price_type: "range",
    description: "Цена зависит от длины и густоты волос",
  },
  {
    category: "Волосы",
    name: "Ботокс для волос",
    duration_min: 120,
    price: 2000,
    price_max: 4500,
    price_type: "range",
  },
  {
    category: "Волосы",
    name: "Химическая завивка",
    duration_min: 150,
    price: 2500,
    price_max: 5000,
    price_type: "range",
  },
  // Ресницы и брови
  {
    category: "Ресницы и брови",
    name: "Наращивание ресниц 2D",
    duration_min: 120,
    price: 1200,
    price_type: "fixed",
  },
  {
    category: "Ресницы и брови",
    name: "Наращивание ресниц 3D (объёмное)",
    duration_min: 120,
    price: 1400,
    price_type: "fixed",
  },
  {
    category: "Ресницы и брови",
    name: "Ламинирование ресниц",
    duration_min: 60,
    price: 900,
    price_type: "fixed",
  },
  {
    category: "Ресницы и брови",
    name: "Ламинирование бровей",
    duration_min: 40,
    price: 700,
    price_type: "fixed",
  },
  {
    category: "Ресницы и брови",
    name: "Коррекция и окрашивание бровей",
    duration_min: 30,
    price: 400,
    price_type: "fixed",
  },
  // Макияж и причёски
  {
    category: "Макияж и причёски",
    name: "Дневной макияж",
    duration_min: 40,
    price: 800,
    price_type: "fixed",
  },
  {
    category: "Макияж и причёски",
    name: "Вечерний / свадебный макияж",
    duration_min: 60,
    price: 1500,
    price_max: 2500,
    price_type: "range",
  },
  {
    category: "Макияж и причёски",
    name: "Праздничная причёска",
    duration_min: 60,
    price: 1000,
    price_max: 2000,
    price_type: "range",
  },
  // Эпиляция
  {
    category: "Эпиляция",
    name: "Шугаринг (зона на выбор)",
    duration_min: 30,
    price: 300,
    price_max: 1500,
    price_type: "range",
  },
  {
    category: "Эпиляция",
    name: "Лазерная эпиляция (зона на выбор)",
    duration_min: 45,
    price: 500,
    price_max: 3000,
    price_type: "range",
  },
  // Подология
  {
    category: "Подология",
    name: "Аппаратный педикюр / подолог",
    duration_min: 60,
    price: 800,
    price_max: 1800,
    price_type: "range",
  },
];

const barbershop: CatalogService[] = [
  {
    category: "Стрижки",
    name: "Стрижка машинкой",
    duration_min: 30,
    price: 350,
    price_type: "fixed",
  },
  {
    category: "Стрижки",
    name: "Стрижка ножницами",
    duration_min: 45,
    price: 500,
    price_type: "fixed",
  },
  {
    category: "Стрижки",
    name: "Фейд (fade) низкий / средний / высокий",
    duration_min: 45,
    price: 600,
    price_type: "fixed",
  },
  {
    category: "Стрижки",
    name: "Детская стрижка",
    duration_min: 30,
    price: 350,
    price_type: "fixed",
  },
  {
    category: "Борода и бритьё",
    name: "Оформление бороды",
    duration_min: 30,
    price: 400,
    price_type: "fixed",
  },
  {
    category: "Борода и бритьё",
    name: "Королевское бритьё опасной бритвой",
    duration_min: 40,
    price: 600,
    price_type: "fixed",
  },
  {
    category: "Борода и бритьё",
    name: "Оформление усов",
    duration_min: 15,
    price: 200,
    price_type: "fixed",
  },
  {
    category: "Борода и бритьё",
    name: "Камуфляж седины бороды",
    duration_min: 30,
    price: 500,
    price_type: "fixed",
  },
  {
    category: "Уход",
    name: "Уход за лицом (чистка, маска)",
    duration_min: 30,
    price: 500,
    price_type: "fixed",
  },
  {
    category: "Комплексы",
    name: "Стрижка + борода",
    duration_min: 60,
    price: 800,
    price_type: "fixed",
  },
  {
    category: "Комплексы",
    name: "Детский комплекс (стрижка + подарок)",
    duration_min: 30,
    price: 400,
    price_type: "fixed",
  },
];

const massage: CatalogService[] = [
  {
    category: "Классический массаж",
    name: "Массаж спины",
    duration_min: 30,
    price: 800,
    price_type: "fixed",
  },
  {
    category: "Классический массаж",
    name: "Массаж всего тела",
    duration_min: 60,
    price: 1500,
    price_type: "fixed",
  },
  {
    category: "Классический массаж",
    name: "Массаж шейно-воротниковой зоны",
    duration_min: 20,
    price: 500,
    price_type: "fixed",
  },
  {
    category: "Спортивный и лечебный",
    name: "Спортивный массаж",
    duration_min: 60,
    price: 1800,
    price_type: "fixed",
  },
  {
    category: "Спортивный и лечебный",
    name: "Антицеллюлитный массаж",
    duration_min: 45,
    price: 1200,
    price_type: "fixed",
  },
  {
    category: "Спортивный и лечебный",
    name: "Лимфодренажный массаж",
    duration_min: 45,
    price: 1300,
    price_type: "fixed",
  },
  {
    category: "Спортивный и лечебный",
    name: "Массаж стоп (рефлексотерапия)",
    duration_min: 30,
    price: 700,
    price_type: "fixed",
  },
  {
    category: "СПА и релакс",
    name: "Медовый массаж",
    duration_min: 45,
    price: 1200,
    price_type: "fixed",
  },
  {
    category: "СПА и релакс",
    name: "Массаж горячими камнями",
    duration_min: 75,
    price: 2200,
    price_type: "fixed",
  },
  {
    category: "СПА и релакс",
    name: "Тайский массаж",
    duration_min: 90,
    price: 2500,
    price_type: "fixed",
  },
  {
    category: "Программы",
    name: "СПА-программа (массаж + обёртывание)",
    duration_min: 120,
    price: 3000,
    price_max: 4000,
    price_type: "range",
  },
];

const dental: CatalogService[] = [
  {
    category: "Диагностика",
    name: "Консультация врача-стоматолога",
    duration_min: 20,
    price: 300,
    price_type: "fixed",
  },
  {
    category: "Диагностика",
    name: "Панорамный снимок (ОПТГ)",
    duration_min: 15,
    price: 500,
    price_type: "fixed",
  },
  {
    category: "Диагностика",
    name: "Консультация ортодонта",
    duration_min: 30,
    price: 500,
    price_type: "fixed",
  },
  {
    category: "Гигиена",
    name: "Профессиональная гигиена полости рта",
    duration_min: 45,
    price: 2000,
    price_type: "fixed",
  },
  {
    category: "Гигиена",
    name: "Отбеливание зубов",
    duration_min: 60,
    price: 4000,
    price_max: 7000,
    price_type: "range",
  },
  {
    category: "Терапия",
    name: "Лечение кариеса (пломба)",
    duration_min: 45,
    price: 1500,
    price_max: 3000,
    price_type: "range",
    description: "Цена зависит от глубины поражения",
  },
  {
    category: "Терапия",
    name: "Лечение пульпита (канал)",
    duration_min: 60,
    price: 3000,
    price_max: 5000,
    price_type: "range",
  },
  {
    category: "Ортодонтия",
    name: "Установка брекет-системы",
    duration_min: 90,
    price: 25000,
    price_max: 45000,
    price_type: "range",
  },
  {
    category: "Хирургия",
    name: "Удаление зуба простое",
    duration_min: 30,
    price: 1200,
    price_type: "fixed",
  },
  {
    category: "Хирургия",
    name: "Удаление зуба сложное (ретинированный)",
    duration_min: 60,
    price: 3500,
    price_type: "fixed",
  },
  {
    category: "Хирургия",
    name: "Имплантация зуба",
    duration_min: 90,
    price: 25000,
    price_max: 45000,
    price_type: "range",
  },
  {
    category: "Протезирование",
    name: "Установка коронки",
    duration_min: 60,
    price: 8000,
    price_max: 15000,
    price_type: "range",
  },
  {
    category: "Детский приём",
    name: "Осмотр детского стоматолога",
    duration_min: 20,
    price: 400,
    price_type: "fixed",
  },
];

const medical: CatalogService[] = [
  {
    category: "Приём врачей",
    name: "Приём терапевта",
    duration_min: 20,
    price: 700,
    price_type: "fixed",
  },
  {
    category: "Приём врачей",
    name: "Приём педиатра",
    duration_min: 20,
    price: 700,
    price_type: "fixed",
  },
  {
    category: "Приём врачей",
    name: "Приём гинеколога",
    duration_min: 25,
    price: 900,
    price_type: "fixed",
  },
  {
    category: "Приём врачей",
    name: "Приём невролога",
    duration_min: 25,
    price: 900,
    price_type: "fixed",
  },
  {
    category: "Приём врачей",
    name: "Приём кардиолога",
    duration_min: 25,
    price: 900,
    price_type: "fixed",
  },
  {
    category: "Диагностика",
    name: "УЗИ органов брюшной полости",
    duration_min: 30,
    price: 1500,
    price_type: "fixed",
  },
  {
    category: "Диагностика",
    name: "ЭКГ с расшифровкой",
    duration_min: 15,
    price: 500,
    price_type: "fixed",
  },
  {
    category: "Анализы",
    name: "Общий анализ крови",
    duration_min: 10,
    price: 300,
    price_type: "fixed",
  },
  {
    category: "Анализы",
    name: "Биохимический анализ крови",
    duration_min: 15,
    price: 800,
    price_type: "fixed",
  },
  {
    category: "Процедуры",
    name: "Внутримышечная инъекция",
    duration_min: 10,
    price: 150,
    price_type: "fixed",
  },
  {
    category: "Процедуры",
    name: "Внутривенная капельница",
    duration_min: 40,
    price: 600,
    price_type: "fixed",
  },
  {
    category: "Процедуры",
    name: "Вакцинация",
    duration_min: 15,
    price: 500,
    price_max: 1500,
    price_type: "range",
  },
  {
    category: "Процедуры",
    name: "Медицинская справка",
    duration_min: 15,
    price: 400,
    price_type: "fixed",
  },
];

const cosmetology: CatalogService[] = [
  {
    category: "Уход за лицом",
    name: "Чистка лица (комбинированная)",
    duration_min: 60,
    price: 1800,
    price_type: "fixed",
  },
  {
    category: "Уход за лицом",
    name: "Пилинг лица (химический)",
    duration_min: 45,
    price: 1500,
    price_max: 3000,
    price_type: "range",
  },
  {
    category: "Уход за лицом",
    name: "Увлажняющая уходовая процедура",
    duration_min: 45,
    price: 1200,
    price_type: "fixed",
  },
  {
    category: "Уход за лицом",
    name: "Массаж лица косметологический",
    duration_min: 40,
    price: 1000,
    price_type: "fixed",
  },
  {
    category: "Инъекционная косметология",
    name: "Биоревитализация",
    duration_min: 40,
    price: 3500,
    price_max: 6000,
    price_type: "range",
  },
  {
    category: "Инъекционная косметология",
    name: "Контурная пластика (филлеры)",
    duration_min: 45,
    price: 8000,
    price_max: 20000,
    price_type: "range",
  },
  {
    category: "Инъекционная косметология",
    name: "Ботулинотерапия (уколы красоты)",
    duration_min: 30,
    price: 6000,
    price_max: 15000,
    price_type: "range",
  },
  {
    category: "Инъекционная косметология",
    name: "Мезотерапия лица",
    duration_min: 40,
    price: 2500,
    price_max: 4500,
    price_type: "range",
  },
  {
    category: "Аппаратная косметология",
    name: "RF-лифтинг лица",
    duration_min: 45,
    price: 2000,
    price_max: 3500,
    price_type: "range",
  },
  {
    category: "Аппаратная косметология",
    name: "Лазерное омоложение",
    duration_min: 45,
    price: 3000,
    price_max: 6000,
    price_type: "range",
  },
  {
    category: "Тело",
    name: "Обёртывание тела",
    duration_min: 60,
    price: 1500,
    price_max: 2500,
    price_type: "range",
  },
];

const epilation: CatalogService[] = [
  {
    category: "Лазерная эпиляция",
    name: "Лазерная эпиляция — подмышки",
    duration_min: 15,
    price: 800,
    price_type: "fixed",
  },
  {
    category: "Лазерная эпиляция",
    name: "Лазерная эпиляция — голени",
    duration_min: 30,
    price: 1800,
    price_type: "fixed",
  },
  {
    category: "Лазерная эпиляция",
    name: "Лазерная эпиляция — бикини классическое",
    duration_min: 20,
    price: 1500,
    price_type: "fixed",
  },
  {
    category: "Лазерная эпиляция",
    name: "Лазерная эпиляция — глубокое бикини",
    duration_min: 30,
    price: 2500,
    price_type: "fixed",
  },
  {
    category: "Лазерная эпиляция",
    name: "Лазерная эпиляция — руки полностью",
    duration_min: 25,
    price: 1600,
    price_type: "fixed",
  },
  {
    category: "Лазерная эпиляция",
    name: "Лазерная эпиляция — лицо",
    duration_min: 15,
    price: 900,
    price_type: "fixed",
  },
  {
    category: "Шугаринг",
    name: "Шугаринг — подмышки",
    duration_min: 20,
    price: 500,
    price_type: "fixed",
  },
  {
    category: "Шугаринг",
    name: "Шугаринг — голени",
    duration_min: 40,
    price: 1200,
    price_type: "fixed",
  },
  {
    category: "Шугаринг",
    name: "Шугаринг — бикини глубокое",
    duration_min: 40,
    price: 1800,
    price_type: "fixed",
  },
  {
    category: "Воск",
    name: "Восковая депиляция — усики",
    duration_min: 10,
    price: 300,
    price_type: "fixed",
  },
  {
    category: "Воск",
    name: "Восковая депиляция — руки",
    duration_min: 25,
    price: 900,
    price_type: "fixed",
  },
];

export const SERVICE_CATALOG_TEMPLATES: Record<IndustryKey, CatalogService[]> = {
  beauty,
  barbershop,
  massage,
  dental,
  medical,
  cosmetology,
  epilation,
};
