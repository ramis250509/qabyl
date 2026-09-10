// Кнопка «Подключить WhatsApp» — окно Embedded Signup от Meta.
//
// ЧТО ПРОИСХОДИТ ПО НАЖАТИЮ. Открывается всплывающее окно Facebook, владелец салона входит,
// выбирает или заводит WhatsApp Business аккаунт и подтверждает номер. Обратно прилетают две
// вещи, и разными путями:
//   • WABA ID и Phone Number ID — событием postMessage от business.facebook.com;
//   • одноразовый код — в колбэке FB.login.
// Поэтому слушатель сообщений вешается ДО вызова login и снимается после: если поставить его
// внутри колбэка, событие успеет прийти раньше подписки и потеряется.
//
// Код в браузере не даёт доступа сам по себе — он меняется на токен на сервере, где есть app
// secret. Поэтому его безопасно возвращать в страницу.
//
// ВЕРСИЯ ПОТОКА — v4. Meta отключает v2 и v3 15 октября 2026 года, и вместе с ними — старые
// feature type'ы. Отличия v4, важные для этого файла:
//   • `sessionInfoVersion` по документации v4 не нужен, но временно возвращён — см. CONFIG_ID;
//   • конфигурация Facebook Login for Business должна быть СОЗДАНА ЗАНОВО под v4 — старый
//     config_id продолжает открывать старый поток и умрёт вместе с ним;
//   • у события появились новые значения `event`, и «успех» теперь не одно слово, а несколько.
// `featureType` остаётся: без него в окне не показывается экран coexistence, а без coexistence
// номер уезжает в облако целиком и WhatsApp Business на телефоне владелицы перестаёт работать.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { getWaSignupSettings } from "@/lib/wa-onboarding.functions";

// Значения по умолчанию — идентификаторы САМОГО Qabyl, и они не секрет: App ID и config ID всё
// равно оказываются в JS страницы, откуда их может прочитать кто угодно. Переменные окружения
// оставлены для переопределения (стенд, второе приложение).
//
// Почему значения по умолчанию вообще нужны. `VITE_*` вшиваются при СБОРКЕ, а `.env` не лежит в
// репозитории — значит прод получает их только из build-переменных Cloudflare. Забытая там
// переменная не роняет сборку, а тихо превращает кнопку в «подключение не настроено» у каждого
// салона. Зависеть в главном действии продукта от поля, которое никто не видит, — плохая сделка.
//
// config_id — конфигурация Facebook Login for Business под Embedded Signup v4, создана 10.09.2026.
// Старая (1363168405899358) открывала поток, который Meta отключает 15.10.2026.
const APP_ID = import.meta.env.VITE_META_APP_ID || "1938248030209290";
// ВРЕМЕННО обратно на 1363168405899358. Новая конфигурация 919884354119444 (создана 10.09, в
// продуктах включён Marketing Messages API) на живом подключении 10.09 показала только обычную
// регистрацию номера — без варианта coexistence, то есть с потерей WhatsApp Business на телефоне
// салона. Старая конфигурация вместе с sessionInfoVersion "3" — единственная проверенная
// комбинация, при которой coexistence работал. Вернуться к новой после выяснения причины.
const CONFIG_ID = import.meta.env.VITE_WA_ES_CONFIG_ID || "1363168405899358";
const GRAPH_VERSION = import.meta.env.VITE_META_GRAPH_VERSION ?? "v25.0";
const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";

/** Чем закончилось окно Meta — с точки зрения владельца, а не протокола. */
export type SignupOutcome =
  | { kind: "ok"; code: string; wabaId: string; phoneNumberId: string; coexistence: boolean }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

/** Грузит SDK один раз на страницу и ждёт готовности. Повторные вызовы переиспользуют его. */
function loadFacebookSdk(): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("нет window"));
  if (window.FB) return Promise.resolve(window.FB);
  if (!APP_ID) return Promise.reject(new Error("VITE_META_APP_ID не задан"));

  return new Promise((resolve, reject) => {
    const finish = () => {
      window.FB.init({
        appId: APP_ID,
        autoLogAppEvents: true,
        xfbml: false,
        version: GRAPH_VERSION,
      });
      resolve(window.FB);
    };

    const existing = document.getElementById("facebook-jssdk") as HTMLScriptElement | null;
    if (existing) {
      // Скрипт уже вставлен другим экземпляром кнопки, но FB ещё не инициализирован.
      existing.addEventListener("load", finish, { once: true });
      existing.addEventListener("error", () => reject(new Error("SDK не загрузился")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = SDK_SRC;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = finish;
    script.onerror = () => reject(new Error("SDK не загрузился"));
    document.body.appendChild(script);
  });
}

/**
 * Значения `event`, при которых подключение состоялось.
 *
 * Их несколько, и это не придирка к формулировкам: FINISH — обычный поток, а
 * FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING — coexistence, то есть ровно тот случай, ради которого
 * мы и просим featureType. Считать успехом только FINISH значило бы объявлять неудачей самый
 * нужный нам исход.
 *
 * FINISH_ONLY_WABA сюда не входит намеренно: владелец дошёл до конца, но номер не выбрал.
 * Подключать нечего, и сказать об этом надо отдельными словами.
 */
const SUCCESS_EVENTS = new Set([
  "FINISH",
  "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
  "FINISH_OBO_MIGRATION",
]);

export function WaConnectButton({
  onConnected,
  connected,
  className,
  size,
}: {
  /** Вызывается с результатом окна. Сохранение и разбор делает родитель. */
  onConnected: (v: SignupOutcome) => Promise<void> | void;
  connected: boolean;
  className?: string;
  size?: "sm" | "lg" | "default";
}) {
  const [busy, setBusy] = useState(false);
  // Держим в ref, а не в state: значения приходят из обработчика события, и перерисовка между
  // приходом сообщения и колбэком login потеряла бы их.
  const session = useRef<{
    wabaId: string | null;
    phoneNumberId: string | null;
    event: string | null;
    errorMessage: string | null;
  }>({ wabaId: null, phoneNumberId: null, event: null, errorMessage: null });

  const configured = Boolean(APP_ID && CONFIG_ID);

  // Solution ID партнёрского решения с YCloud. Приходит с сервера, потому что появляется после
  // одобрения и не должен требовать пересборки. Промис, а не state: окно Meta нужно открыть в том же
  // жесте пользователя, и ждать перерисовки ради одного поля нельзя.
  const loadSettings = useServerFn(getWaSignupSettings);
  const settingsPromise = useRef<Promise<{
    solutionId: string | null;
    configId: string | null;
  }> | null>(null);
  useEffect(() => {
    settingsPromise.current = loadSettings().catch(() => ({ solutionId: null, configId: null }));
  }, [loadSettings]);

  useEffect(() => {
    if (!configured) return;
    // Прогреваем SDK заранее: иначе первое нажатие ждёт сеть, и владельцу кажется, что кнопка
    // не сработала. Тихо — неудача здесь всплывёт понятной ошибкой уже при нажатии.
    loadFacebookSdk().catch(() => {});
  }, [configured]);

  async function connect() {
    if (!configured) {
      toast.error(
        "Подключение WhatsApp не настроено на стороне платформы. Напишите в поддержку — это чинится у нас, а не у вас.",
      );
      return;
    }

    setBusy(true);
    session.current = { wabaId: null, phoneNumberId: null, event: null, errorMessage: null };

    const onMessage = (event: MessageEvent) => {
      // Строгая проверка источника: в окно прилетают сообщения и от посторонних скриптов.
      if (
        event.origin !== "https://www.facebook.com" &&
        event.origin !== "https://web.facebook.com"
      )
        return;
      try {
        const parsed = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (parsed?.type !== "WA_EMBEDDED_SIGNUP") return;
        if (parsed?.event) session.current.event = String(parsed.event);
        if (parsed?.data?.waba_id) session.current.wabaId = String(parsed.data.waba_id);
        if (parsed?.data?.phone_number_id)
          session.current.phoneNumberId = String(parsed.data.phone_number_id);
        // В v4 у ошибки есть текст, и он единственный намёк на причину: в колбэке login её нет.
        if (parsed?.data?.error_message)
          session.current.errorMessage = String(parsed.data.error_message);
      } catch {
        // Не наше сообщение — молча пропускаем.
      }
    };

    window.addEventListener("message", onMessage);
    const cleanup = () => window.removeEventListener("message", onMessage);

    try {
      const FB = await loadFacebookSdk();
      const settings = await (settingsPromise.current ??
        Promise.resolve({ solutionId: null, configId: null }));
      const solutionID = settings.solutionId;

      const response: any = await new Promise((resolve) => {
        FB.login(resolve, {
          // Переменная WA_ES_CONFIG_ID на сервере перекрывает значение в коде — см. getWaSignupSettings.
          config_id: settings.configId || CONFIG_ID,
          // Просим КОД, а не токен: токен в браузере — это утечка, а код без app secret
          // бесполезен.
          response_type: "code",
          override_default_response_type: true,
          extras: {
            // С solutionID салон попадает в партнёрское решение, и за его сообщения платит
            // кредитная линия YCloud. Без него — как раньше: оплата на карте салона в Meta.
            setup: solutionID ? { solutionID } : {},
            // Решает судьбу номера салона. Без него — обычный поток: номер уезжает в Cloud API,
            // а аккаунт в приложении WhatsApp Business удаляется, и владелец теряет возможность
            // отвечать с телефона. С ним открывается coexistence: приложение и API живут на одном
            // номере, история синхронизируется, ответы владельца приходят вебхуком
            // smb_message_echoes. Цена — потолок 20 сообщений/сек и часть функций приложения.
            featureType: "whatsapp_business_app_onboarding",
            // Возвращён вместе со старой конфигурацией (см. CONFIG_ID): без него на живом
            // подключении окно не предлагало coexistence.
            sessionInfoVersion: "3",
          },
        });
      });

      const ev = session.current.event;

      if (ev === "CANCEL") {
        await onConnected({ kind: "cancelled" });
        return;
      }
      if (ev === "ERROR") {
        await onConnected({
          kind: "error",
          message:
            session.current.errorMessage ??
            "Meta прервала подключение. Попробуйте ещё раз — если повторится, напишите нам.",
        });
        return;
      }
      if (ev === "FINISH_ONLY_WABA") {
        await onConnected({
          kind: "error",
          message:
            "Аккаунт WhatsApp выбран, но номер не подтверждён. Пройдите подключение ещё раз и дойдите до шага с номером телефона.",
        });
        return;
      }

      const code = response?.authResponse?.code;
      if (!code) {
        // Закрыл окно или отказал в доступе — это не ошибка, а решение.
        await onConnected({ kind: "cancelled" });
        return;
      }

      const { wabaId, phoneNumberId } = session.current;
      if (!wabaId || !phoneNumberId) {
        await onConnected({
          kind: "error",
          message:
            "Meta не вернула данные аккаунта. Попробуйте ещё раз и дойдите до конца окна, не закрывая его раньше времени.",
        });
        return;
      }
      if (ev && !SUCCESS_EVENTS.has(ev)) {
        // Незнакомый исход. Данные есть, код есть — пробуем, но пишем в консоль: это первый
        // признак того, что Meta снова поменяла поток.
        console.warn("[wa-signup] неизвестное событие Embedded Signup:", ev);
      }

      await onConnected({
        kind: "ok",
        code,
        wabaId,
        phoneNumberId,
        coexistence: ev === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      });
    } catch (e: any) {
      await onConnected({
        kind: "error",
        message: e?.message ?? "Не удалось открыть окно подключения",
      });
    } finally {
      cleanup();
      setBusy(false);
    }
  }

  return (
    <Button
      onClick={connect}
      disabled={busy}
      size={size}
      variant={connected ? "outline" : "default"}
      className={className}
    >
      {busy ? "Открываем окно Meta…" : connected ? "Подключить заново" : "Подключить WhatsApp"}
    </Button>
  );
}
