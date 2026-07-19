import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "ru" | "ky" | "en";

// Languages offered in the UI switcher, in display order. Single source of truth — adding a
// language is: (1) add its code here with a label, (2) fill in translations in DICT (any key
// left without that language falls back to Russian, so coverage can grow incrementally).
export const LANGS: { code: Lang; label: string }[] = [
  { code: "ru", label: "RU" },
  { code: "ky", label: "KY" },
];

// Per-key translations. `ru` is required (the fallback); every other language is optional so
// new languages don't force a full retranslation up front.
type Entry = { ru: string } & Partial<Record<Lang, string>>;

const DICT = {
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
  hour: { ru: "ч", ky: "саат", en: "h" },
  loading: { ru: "Загрузка...", ky: "Жүктөлүүдө...", en: "Loading..." },
  notFound: { ru: "Салон не найден", ky: "Салон табылган жок", en: "Salon not found" },

  // Booking widget — steps
  stepBranch: { ru: "Филиал", ky: "Филиал", en: "Branch" },
  stepService: { ru: "Услуга", ky: "Кызмат", en: "Service" },
  stepMaster: { ru: "Мастер", ky: "Чебер", en: "Master" },
  stepTime: { ru: "Время", ky: "Убакыт", en: "Time" },
  stepContacts: { ru: "Контакты", ky: "Байланыш", en: "Contacts" },

  chooseBranch: { ru: "Выберите филиал", ky: "Филиалды тандаңыз", en: "Choose a branch" },
  toBranchChoice: { ru: "К выбору филиала", ky: "Филиалды тандоого", en: "Back to branches" },
  selectService: { ru: "Выберите услугу", ky: "Кызматты тандаңыз", en: "Choose a service" },
  servicesEmpty: {
    ru: "Услуги пока не добавлены",
    ky: "Кызматтар азырынча кошулган жок",
    en: "No services yet",
  },
  selectMaster: { ru: "Выберите мастера", ky: "Чеберди тандаңыз", en: "Choose a master" },
  noMastersForService: {
    ru: "Нет мастеров для этой услуги",
    ky: "Бул кызмат үчүн чеберлер жок",
    en: "No masters for this service",
  },
  selectTime: { ru: "Выберите время", ky: "Убакытты тандаңыз", en: "Choose a time" },
  loadingSlots: { ru: "Загрузка слотов...", ky: "Убакыттар жүктөлүүдө...", en: "Loading times..." },
  noFreeTime: {
    ru: "На этот день свободного времени нет",
    ky: "Бул күнгө бош убакыт жок",
    en: "No free time on this day",
  },
  masterDayOff: { ru: "Выходной у мастера", ky: "Чебердин эс алуу күнү", en: "Master's day off" },
  masterDayOffPick: {
    ru: "У мастера в этот день выходной — выберите другую дату.",
    ky: "Бул күнү чебердин эс алуусу — башка күндү тандаңыз.",
    en: "The master is off this day — pick another date.",
  },

  // Booking widget — contacts step
  yourContacts: { ru: "Ваши контакты", ky: "Байланыш маалыматыңыз", en: "Your contacts" },
  yourName: { ru: "Ваше имя", ky: "Атыңыз", en: "Your name" },
  nameLabel: { ru: "Имя", ky: "Атыңыз", en: "Name" },
  phoneWhatsapp: { ru: "Телефон (WhatsApp)", ky: "Телефон (WhatsApp)", en: "Phone (WhatsApp)" },
  commentOptional: {
    ru: "Комментарий (необязательно)",
    ky: "Комментарий (милдеттүү эмес)",
    en: "Comment (optional)",
  },
  total: { ru: "Итого", ky: "Жыйынтык", en: "Total" },
  additionally: { ru: "Дополнительно", ky: "Кошумча", en: "Add-ons" },
  optionalHint: { ru: "по желанию", ky: "каалоо боюнча", en: "optional" },
  addonSameTime: {
    ru: "Выполняется одновременно с основной услугой — общее время записи не увеличивается.",
    ky: "Негизги кызмат менен бир убакта аткарылат — жазуу убактысы көбөйбөйт.",
    en: "Done alongside the main service — the total booking time doesn't increase.",
  },
  phoneInvalid: {
    ru: "Введите корректный номер: +996 и 9 цифр, например +996 (555) 12-34-56.",
    ky: "Туура номер киргизиңиз: +996 жана 9 сан, мисалы +996 (555) 12-34-56.",
    en: "Enter a valid number: +996 and 9 digits, e.g. +996 (555) 12-34-56.",
  },
  phoneNotWhatsapp: {
    ru: "Этот номер не зарегистрирован в WhatsApp. Укажите номер, привязанный к WhatsApp — на него придёт подтверждение записи.",
    ky: "Бул номер WhatsApp'та катталган эмес. WhatsApp'ка байланган номерди көрсөтүңүз — ага жазуу тастыктамасы келет.",
    en: "This number isn't on WhatsApp. Enter a WhatsApp number — the confirmation will be sent there.",
  },
  salonRuleTitle: {
    ru: "Внимание! Важное правило салона",
    ky: "Көңүл буруңуз! Салондун маанилүү эрежеси",
    en: "Note: important salon rule",
  },
  lateRuleBody: {
    ru: "Если вы опоздаете более чем на 10 минут, ваша запись будет автоматически аннулирована, если в салоне будут присутствовать другие клиенты.",
    ky: "Эгер сиз 10 мүнөттөн ашык кечиксеңиз, салондо башка кардарлар болсо, жазууңуз автоматтык түрдө жокко чыгарылат.",
    en: "If you're more than 10 minutes late, your booking is cancelled automatically when other clients are present.",
  },
  lateRuleAsk: {
    ru: "Пожалуйста, уважайте время мастеров и приходите вовремя.",
    ky: "Сураныч, чеберлердин убактысын урматтап, өз убагында келиңиз.",
    en: "Please respect the masters' time and arrive on time.",
  },
  agreeLate: {
    ru: "Я подтверждаю, что приду вовремя и согласен с правилом отмены при опоздании на 10 минут.",
    ky: "Мен өз убагында келерими жана 10 мүнөткө кечиккенде жокко чыгаруу эрежесине макул экенимди тастыктайм.",
    en: "I confirm I'll arrive on time and accept the 10-minute late-cancellation rule.",
  },
  agreeWhatsapp: {
    ru: "Подтверждая запись, вы соглашаетесь на получение уведомлений в WhatsApp по указанному номеру.",
    ky: "Жазылууну тастыктоо менен сиз көрсөтүлгөн номерге WhatsApp билдирүүлөрүн алууга макул болосуз.",
    en: "By confirming, you agree to receive WhatsApp notifications at the number provided.",
  },
  confirmBooking: { ru: "Подтвердить запись", ky: "Жазылууну тастыктоо", en: "Confirm booking" },
  submitting: { ru: "Записываем...", ky: "Жазылууда...", en: "Booking..." },

  // Booking widget — success screen
  bookingCreated: {
    ru: "Ваша запись успешно создана!",
    ky: "Жазылууңуз ийгиликтүү түзүлдү!",
    en: "Your booking is confirmed!",
  },
  sentWhatsappTo: {
    ru: "Мы отправили подтверждение в WhatsApp на номер",
    ky: "Биз WhatsApp аркылуу тастыктоо жибердик, номер",
    en: "We've sent a WhatsApp confirmation to",
  },
  weWaitYouAt: { ru: "Ждём вас в", ky: "Сизди күтөбүз:", en: "See you at" },
  atTime: { ru: "в", ky: "саат", en: "at" },
  bookAgain: { ru: "Записаться ещё раз", ky: "Дагы жазылуу", en: "Book again" },
  toHome: { ru: "На главную", ky: "Башкы бетке", en: "Home" },

  // Misc
  back: { ru: "Назад", ky: "Артка", en: "Back" },
  next: { ru: "Далее", ky: "Андан ары", en: "Next" },
  branch: { ru: "Филиал", ky: "Филиал", en: "Branch" },
  other: { ru: "Прочее", ky: "Башкалар", en: "Other" },
  faqTitle: { ru: "Частые вопросы", ky: "Көп берилүүчү суроолор", en: "FAQ" },
} satisfies Record<string, Entry>;

export type DictKey = keyof typeof DICT;

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (k: DictKey) => string; forced: boolean };
const I18nContext = createContext<Ctx>({
  lang: "ru",
  setLang: () => {},
  t: (k) => DICT[k]?.ru ?? String(k),
  forced: false,
});

export function I18nProvider({ children, forceLang }: { children: ReactNode; forceLang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(forceLang ?? "ru");
  useEffect(() => {
    if (forceLang) {
      setLangState(forceLang);
      return;
    }
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem("lang") as Lang | null;
    if (saved && LANGS.some((l) => l.code === saved)) setLangState(saved);
  }, [forceLang]);
  const setLang = (l: Lang) => {
    if (forceLang) return;
    setLangState(l);
    if (typeof window !== "undefined") window.localStorage.setItem("lang", l);
  };
  const t = (k: DictKey) => DICT[k]?.[lang] ?? DICT[k]?.ru ?? String(k);
  return (
    <I18nContext.Provider value={{ lang, setLang, t, forced: !!forceLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT() {
  return useContext(I18nContext);
}

export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { lang, setLang, forced } = useT();
  if (forced || LANGS.length < 2) return null;
  return (
    <div
      className={`inline-flex items-center rounded-full border border-current/20 p-0.5 text-xs font-medium ${className}`}
    >
      {LANGS.map((o) => (
        <button
          key={o.code}
          onClick={() => setLang(o.code)}
          className={`px-2.5 py-1 rounded-full transition ${lang === o.code ? "bg-current/15" : "opacity-60 hover:opacity-100"}`}
          aria-pressed={lang === o.code}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
