// Язык кабинета: русский или английский.
//
// ЗАЧЕМ. Кабинет пишется по-русски и для салонов таким остаётся — по умолчанию ничего не
// меняется. Английский понадобился проверяющим Meta: App Review требует снимать видео на
// английском интерфейсе, и заявку на Instagram-разрешения отклонили в том числе потому, что
// переключить кабинет на английский было нельзя вовсе.
//
// ПОЧЕМУ НЕ i18n.tsx. Там язык публичной страницы салона для его клиентов, с переключателем на
// самой странице. Язык кабинета — выбор владельца для себя: переключив кабинет, он не должен
// заодно переключить свою страницу записи. Поэтому у кабинета свой ключ в localStorage.
//
// ПОЧЕМУ ПАРЫ СТРОК, А НЕ КЛЮЧИ. tr("Сохранить", "Save") держит перевод рядом с оригиналом:
// меняя русскую фразу, английскую видно в той же строке, и забыть её труднее, чем запись в
// словаре на другом конце проекта. Переведены экраны, которые видит проверяющий Meta; остальные
// пока по-русски — tr можно добавлять по мере надобности, экран за экраном.
import { useSyncExternalStore } from "react";

export type AdminLang = "ru" | "en";
export type Tr = (ru: string, en: string) => string;

const STORAGE_KEY = "qb_admin_lang";
const listeners = new Set<() => void>();
let current: AdminLang | null = null;

function readStored(): AdminLang {
  if (typeof window === "undefined") return "ru";
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "ru";
  } catch {
    // Приватный режим или запрет хранилища: кабинет просто остаётся русским.
    return "ru";
  }
}

function getLang(): AdminLang {
  if (current === null) current = readStored();
  return current;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setAdminLang(lang: AdminLang) {
  current = lang;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Не запомнится между заходами, но на этом экране переключится.
  }
  listeners.forEach((cb) => cb());
}

export function makeTr(lang: AdminLang): Tr {
  return (ru, en) => (lang === "en" ? en : ru);
}

/** Для дат через toLocale*String: «24 сентября» против «September 24». */
export function adminLocale(lang: AdminLang): string {
  return lang === "en" ? "en-US" : "ru-RU";
}

/**
 * Сервер всегда рисует русский (языка владельца он не знает), браузер после загрузки подхватывает
 * сохранённый выбор. useSyncExternalStore делает это без ошибки гидрации и перерисовывает все
 * экраны сразу, когда язык переключили.
 */
export function useAdminLang() {
  const lang = useSyncExternalStore(subscribe, getLang, () => "ru" as AdminLang);
  return { lang, tr: makeTr(lang), setLang: setAdminLang };
}

export function AdminLangSwitcher({ className = "" }: { className?: string }) {
  const { lang, setLang } = useAdminLang();
  return (
    <div
      role="group"
      aria-label={lang === "en" ? "Dashboard language" : "Язык кабинета"}
      className={`inline-flex items-center rounded-full border p-0.5 text-xs font-medium ${className}`}
    >
      {(["ru", "en"] as const).map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLang(code)}
          aria-pressed={lang === code}
          className={`rounded-full px-2.5 py-1 transition ${
            lang === code
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
