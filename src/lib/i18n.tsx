import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "ru" | "ky" | "en";

const DICT: Record<string, Record<Lang, string>> = {
  book: { ru: "Записаться", ky: "Жазылуу", en: "Book now" },
  bookShort: { ru: "Записаться", ky: "Жазылуу", en: "Book" },
  services: { ru: "Услуги", ky: "Кызматтар", en: "Services" },
  masters: { ru: "Мастера", ky: "Чеберлер", en: "Masters" },
  gallery: { ru: "Работы", ky: "Иштер", en: "Gallery" },
  reviews: { ru: "Отзывы", ky: "Пикирлер", en: "Reviews" },
  contacts: { ru: "Контакты", ky: "Байланыш", en: "Contacts" },
  about: { ru: "О нас", ky: "Биз жөнүндө", en: "About" },
  address: { ru: "Адрес", ky: "Дарек", en: "Address" },
  phone: { ru: "Телефон", ky: "Телефон", en: "Phone" },
  hours: { ru: "Часы работы", ky: "Иш убактысы", en: "Working hours" },
  min: { ru: "мин", ky: "мүн", en: "min" },
  loading: { ru: "Загрузка...", ky: "Жүктөлүүдө...", en: "Loading..." },
  notFound: { ru: "Салон не найден", ky: "Салон табылган жок", en: "Salon not found" },
  selectService: { ru: "Выберите услугу", ky: "Кызматты тандаңыз", en: "Choose a service" },
  selectMaster: { ru: "Выберите мастера", ky: "Чеберди тандаңыз", en: "Choose a master" },
  selectDate: { ru: "Выберите дату", ky: "Күндү тандаңыз", en: "Choose a date" },
  selectTime: { ru: "Выберите время", ky: "Убакытты тандаңыз", en: "Choose a time" },
  yourName: { ru: "Ваше имя", ky: "Атыңыз", en: "Your name" },
  yourPhone: { ru: "Телефон", ky: "Телефон", en: "Phone" },
  notes: { ru: "Комментарий", ky: "Комментарий", en: "Notes" },
  confirm: { ru: "Подтвердить запись", ky: "Жазылууну тастыктоо", en: "Confirm booking" },
  back: { ru: "Назад", ky: "Артка", en: "Back" },
  next: { ru: "Далее", ky: "Андан ары", en: "Next" },
  branch: { ru: "Филиал", ky: "Филиал", en: "Branch" },
};

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (k: keyof typeof DICT) => string; forced: boolean };
const I18nContext = createContext<Ctx>({
  lang: "ru",
  setLang: () => {},
  t: (k) => DICT[k]?.ru ?? String(k),
  forced: false,
});

export function I18nProvider({ children, forceLang }: { children: ReactNode; forceLang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(forceLang ?? "ru");
  useEffect(() => {
    if (forceLang) { setLangState(forceLang); return; }
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem("lang") as Lang | null;
    if (saved && ["ru", "ky", "en"].includes(saved)) setLangState(saved);
  }, [forceLang]);
  const setLang = (l: Lang) => {
    if (forceLang) return;
    setLangState(l);
    if (typeof window !== "undefined") window.localStorage.setItem("lang", l);
  };
  const t = (k: keyof typeof DICT) => DICT[k]?.[lang] ?? DICT[k]?.ru ?? String(k);
  return <I18nContext.Provider value={{ lang, setLang, t, forced: !!forceLang }}>{children}</I18nContext.Provider>;
}

export function useT() {
  return useContext(I18nContext);
}

export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { lang, setLang, forced } = useT();
  if (forced) return null;
  const opts: { v: Lang; label: string }[] = [
    { v: "ru", label: "RU" },
    { v: "ky", label: "KY" },
    { v: "en", label: "EN" },
  ];
  return (
    <div className={`inline-flex items-center rounded-full border border-current/20 p-0.5 text-xs font-medium ${className}`}>
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => setLang(o.v)}
          className={`px-2.5 py-1 rounded-full transition ${lang === o.v ? "bg-current/15" : "opacity-60 hover:opacity-100"}`}
          aria-pressed={lang === o.v}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
