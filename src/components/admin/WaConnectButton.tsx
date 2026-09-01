// Кнопка «Подключить WhatsApp» — окно Embedded Signup от Meta.
//
// Что происходит по нажатию: открывается всплывающее окно Facebook, владелец салона входит,
// выбирает или заводит WhatsApp Business аккаунт и подтверждает номер. Обратно прилетают две
// вещи, и разными путями:
//   • WABA ID и Phone Number ID — событием postMessage от business.facebook.com;
//   • одноразовый код — в колбэке FB.login.
// Поэтому слушатель сообщений вешается ДО вызова login и снимается после: если поставить его
// внутри колбэка, событие успеет прийти раньше подписки и потеряется.
//
// Код в браузере не даёт доступа сам по себе — он меняется на токен на сервере, где есть app
// secret. Поэтому его безопасно возвращать в страницу.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const APP_ID = import.meta.env.VITE_META_APP_ID || "1938248030209290";
const CONFIG_ID = import.meta.env.VITE_WA_ES_CONFIG_ID || "1363168405899358";
const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";

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

  return new Promise((resolve, reject) => {
    const finish = () => {
      window.FB.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: false, version: "v25.0" });
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

export function WaConnectButton({
  onConnected,
  connected,
}: {
  /** Вызывается с данными подключения — сохранение делает родитель. */
  onConnected: (v: { code: string; wabaId: string; phoneNumberId: string }) => Promise<void>;
  connected: boolean;
}) {
  const [busy, setBusy] = useState(false);
  // Держим в ref, а не в state: значения приходят из обработчика события, и перерисовка между
  // приходом сообщения и колбэком login потеряла бы их.
  const session = useRef<{ wabaId: string | null; phoneNumberId: string | null }>({
    wabaId: null,
    phoneNumberId: null,
  });

  useEffect(() => {
    // Прогреваем SDK заранее: иначе первое нажатие ждёт сеть, и владельцу кажется, что кнопка
    // не сработала. Тихо — неудача здесь всплывёт понятной ошибкой уже при нажатии.
    loadFacebookSdk().catch(() => {});
  }, []);

  async function connect() {
    setBusy(true);
    session.current = { wabaId: null, phoneNumberId: null };

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
        if (parsed?.data?.waba_id) session.current.wabaId = String(parsed.data.waba_id);
        if (parsed?.data?.phone_number_id)
          session.current.phoneNumberId = String(parsed.data.phone_number_id);
      } catch {
        // Не наше сообщение — молча пропускаем.
      }
    };

    window.addEventListener("message", onMessage);
    const cleanup = () => window.removeEventListener("message", onMessage);

    try {
      const FB = await loadFacebookSdk();

      const response: any = await new Promise((resolve) => {
        FB.login(resolve, {
          config_id: CONFIG_ID,
          // Просим КОД, а не токен: токен в браузере — это утечка, а код без app secret
          // бесполезен.
          response_type: "code",
          override_default_response_type: true,
          // featureType решает судьбу номера салона. Пустая строка — обычный флоу: номер
          // уезжает в Cloud API, а аккаунт в приложении WhatsApp Business удаляется, и владелец
          // теряет возможность отвечать с телефона. `whatsapp_business_app_onboarding` открывает
          // coexistence: приложение и API живут на одном номере. Значение `coexistence` Meta
          // больше не принимает.
          extras: {
            setup: {},
            featureType: "whatsapp_business_app_onboarding",
            sessionInfoVersion: "3",
          },
        });
      });

      const code = response?.authResponse?.code;
      if (!code) {
        // Закрыл окно или отказал в доступе — это не ошибка, а решение.
        toast.info("Подключение отменено");
        return;
      }

      const { wabaId, phoneNumberId } = session.current;
      if (!wabaId || !phoneNumberId) {
        toast.error(
          "Meta не вернула данные аккаунта. Попробуйте ещё раз и дойдите до конца окна, не закрывая его.",
        );
        return;
      }

      await onConnected({ code, wabaId, phoneNumberId });
    } catch (e: any) {
      toast.error(e?.message ?? "Не удалось открыть окно подключения");
    } finally {
      cleanup();
      setBusy(false);
    }
  }

  return (
    <Button onClick={connect} disabled={busy} variant={connected ? "outline" : "default"}>
      {busy
        ? "Открываем окно Meta…"
        : connected
          ? "Переподключить WhatsApp"
          : "Подключить WhatsApp"}
    </Button>
  );
}
