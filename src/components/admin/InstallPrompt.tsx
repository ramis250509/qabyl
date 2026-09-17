// Предложение поставить Qabyl на телефон.
//
// ПОЧЕМУ НЕ СРАЗУ ПОСЛЕ РЕГИСТРАЦИИ. Человек, который ещё не понял, что это за продукт, на вопрос
// «установить?» отвечает «нет» — и второго шанса браузер не даёт: событие beforeinstallprompt
// приходит один раз за сессию. Поэтому ждём, пока он реально поработает: три захода в кабинет.
// К этому моменту он уже видел свои записи, и «открывать как приложение» — понятное предложение,
// а не всплывашка от незнакомца.
//
// ПОЧЕМУ ЭТО НЕ МОДАЛЬНОЕ ОКНО. Установка приложения никогда не бывает срочной. Полоска снизу
// ждёт столько, сколько нужно, и закрывается крестиком навсегда.
//
// iOS. Safari не поддерживает beforeinstallprompt вообще: там установка делается руками через
// «Поделиться» → «На экран Домой». Значит, и предложение должно быть другим — не кнопка, а
// объяснение, где эта кнопка у него в браузере. Без этого владельцы iPhone не получают пушей
// в принципе (iOS шлёт их только установленному приложению).
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, Share, X } from "lucide-react";
import { isIos, isStandalonePWA } from "@/lib/push";

const DISMISSED_KEY = "qb_install_dismissed";
const VISITS_KEY = "qb_admin_visits";

/**
 * Телефон/планшет или компьютер — по типу указателя, а не по ширине окна.
 *
 * Ширина врёт: узкое окно на ноутбуке — это не телефон, а развёрнутый планшет — не компьютер.
 * Нужно это ровно для одного: не обещать человеку за ноутбуком «Qabyl на телефоне». Обещание,
 * не совпадающее с тем, что человек видит, читается как ошибка сайта.
 */
function isHandheld(): boolean {
  try {
    return window.matchMedia?.("(pointer: coarse)").matches ?? false;
  } catch {
    return false;
  }
}
/** Столько заходов в кабинет до предложения. Меньше — навязчиво, больше — никогда не покажем. */
const VISITS_BEFORE_ASK = 3;

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

function readNumber(key: string): number {
  try {
    return Number(localStorage.getItem(key) ?? "0") || 0;
  } catch {
    return 0;
  }
}

function bumpVisits(): number {
  try {
    const n = readNumber(VISITS_KEY) + 1;
    localStorage.setItem(VISITS_KEY, String(n));
    return n;
  } catch {
    return 0;
  }
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * Состояние установки для экрана, который спрашивает о ней сам.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ ПОЛОСКИ. Полоска внизу приходит один раз и закрывается навсегда — это
 * правильно для предложения, которое человек не просил. Но тот, кто закрыл её, а через месяц
 * решил поставить приложение, должен иметь куда пойти. Эта же логика, но по запросу: карточка
 * в «Аккаунте», которая не исчезает и ничего не навязывает.
 */
export function useInstallState() {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setInstalled(isStandalonePWA());
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as InstallEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return {
    installed,
    /** Браузер готов показать системное окно установки. */
    canInstall: Boolean(deferred),
    /** iOS ставится только руками через «Поделиться» — кнопки там не будет никогда. */
    isIos: typeof window !== "undefined" && isIos(),
    async install() {
      if (!deferred) return;
      try {
        await deferred.prompt();
        await deferred.userChoice;
      } catch {
        /* закрыл системное окно — не ошибка */
      }
    },
  };
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null);
  const [show, setShow] = useState(false);
  const [iosHint, setIosHint] = useState(false);
  const [handheld, setHandheld] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setHandheld(isHandheld());
    if (isStandalonePWA()) return; // уже установлено
    if (dismissed()) return;

    const visits = bumpVisits();
    const earned = visits >= VISITS_BEFORE_ASK;

    if (isIos()) {
      // На iOS ждать нечего: события не будет, показываем подсказку сами.
      if (earned) setIosHint(true);
      return;
    }

    const onPrompt = (e: Event) => {
      // Браузер показал бы свою собственную плашку — забираем событие себе, чтобы спросить
      // тогда, когда это уместно, и своими словами.
      e.preventDefault();
      setDeferred(e as InstallEvent);
      if (earned) setShow(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);

    const onInstalled = () => {
      setShow(false);
      close();
    };
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function close() {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* пусто */
    }
    setShow(false);
    setIosHint(false);
  }

  async function install() {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      /* человек закрыл системное окно — это не ошибка */
    }
    close();
  }

  if (!show && !iosHint) return null;

  return (
    <div
      className="qb-rise fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-xl border bg-card p-4 shadow-lg sm:left-auto sm:right-4 sm:mx-0"
      role="region"
      aria-label="Установить Qabyl"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          {iosHint ? (
            <Share className="h-4 w-4 text-primary" />
          ) : (
            <Download className="h-4 w-4 text-primary" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {iosHint || handheld ? "Qabyl на телефоне" : "Qabyl на ноутбуке"}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {iosHint
              ? "Нажмите «Поделиться» внизу Safari и выберите «На экран „Домой“». Так Qabyl откроется как обычное приложение — и только так iPhone сможет присылать уведомления о новых записях."
              : handheld
                ? "Установите — будете открывать как обычное приложение с экрана телефона и получать уведомления о новых записях."
                : "Установите — Qabyl появится отдельным значком и будет открываться в своём окне, без вкладок и адресной строки. Уведомления о новых записях приходят так же."}
          </p>
          <div className="mt-3 flex items-center gap-2">
            {!iosHint && (
              <Button size="sm" onClick={install}>
                Установить
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={close}>
              {iosHint ? "Понятно" : "Не сейчас"}
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Закрыть"
          className="qb-press -mr-1 -mt-1 shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
