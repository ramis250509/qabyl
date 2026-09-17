// Страница «Приложение» — постоянный вход в установку.
//
// ЗАЧЕМ ОТДЕЛЬНАЯ СТРАНИЦА. Полоска снизу (InstallPrompt) приходит один раз и закрывается
// навсегда — это правильно для предложения, которое человек не просил. Но тот, кто её закрыл,
// сменил телефон или решил поставить Qabyl ещё и на ноутбук, должен иметь куда пойти. Сюда можно
// заходить сколько угодно раз, ничего не «истратив».
//
// ПОЧЕМУ ДВА ШАГА. Установка и уведомления — разные разрешения, и их дают в разное время. На
// iPhone порядок обязателен: Safari не показывает запрос на уведомления, пока Qabyl не добавлен
// на экран «Домой». Поэтому шаги пронумерованы, а не свалены в одну кнопку.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Bell, BellRing, Check, Monitor, Share, Smartphone } from "lucide-react";
import { useInstallState } from "@/components/admin/InstallPrompt";
import { ensurePushSubscription, isPushSupported } from "@/lib/push";

export const Route = createFileRoute("/admin/install")({
  head: () => ({ meta: [{ title: "Приложение — Qabyl" }] }),
  component: InstallPage,
});

type PushState = "unsupported" | "default" | "granted" | "denied";

function readPushState(): PushState {
  if (!isPushSupported() || typeof Notification === "undefined") return "unsupported";
  const p = Notification.permission;
  return p === "granted" ? "granted" : p === "denied" ? "denied" : "default";
}

/** Телефон/планшет или компьютер. По типу указателя, а не по ширине окна — см. InstallPrompt. */
function useHandheld(): boolean {
  const [handheld, setHandheld] = useState(true);
  useEffect(() => {
    try {
      setHandheld(window.matchMedia?.("(pointer: coarse)").matches ?? false);
    } catch {
      setHandheld(false);
    }
  }, []);
  return handheld;
}

function Step({
  n,
  done,
  title,
  icon,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
            done ? "bg-success/10" : "bg-primary/10"
          }`}
        >
          {done ? <Check className="h-5 w-5 text-success" /> : icon}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">
            <span className="text-muted-foreground">Шаг {n}. </span>
            {title}
          </h2>
          {children}
        </div>
      </div>
    </Card>
  );
}

function InstallPage() {
  const { installed, canInstall, isIos, install } = useInstallState();
  const handheld = useHandheld();
  const [push, setPush] = useState<PushState>("unsupported");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPush(readPushState());
  }, [installed]);

  async function allowNotifications() {
    setBusy(true);
    try {
      const res = await ensurePushSubscription();
      setPush(readPushState());
      if (res.ok) toast.success("Уведомления включены — пришлём, как только появится новая запись");
      else if (readPushState() === "denied")
        toast.error("Уведомления заблокированы в настройках браузера для этого сайта");
      else toast.error("Не получилось включить уведомления. Попробуйте ещё раз");
    } catch {
      toast.error("Не получилось включить уведомления. Попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  }

  const device = handheld ? "телефоне" : "компьютере";

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold">Приложение Qabyl</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Qabyl можно поставить на {device} — он откроется своим значком, без вкладок и адресной
          строки, и будет присылать уведомления о новых записях. Сюда можно возвращаться в любой
          момент и поставить приложение ещё на одно устройство.
        </p>
      </div>

      <Step
        n={1}
        done={installed}
        title={handheld ? "Установить на телефон" : "Установить на компьютер"}
        icon={
          handheld ? (
            <Smartphone className="h-5 w-5 text-primary" />
          ) : (
            <Monitor className="h-5 w-5 text-primary" />
          )
        }
      >
        {installed ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            Готово — вы открыли Qabyl из установленного приложения. Чтобы поставить его ещё и на
            другое устройство, откройте эту страницу там.
          </p>
        ) : isIos ? (
          <div className="mt-1 space-y-2 text-sm text-muted-foreground">
            <p>
              На iPhone приложение ставится вручную — у Safari нет кнопки установки. И только так
              телефон сможет присылать уведомления о новых записях.
            </p>
            <ol className="ml-4 list-decimal space-y-1">
              <li>Откройте Qabyl в Safari</li>
              <li>
                Нажмите <Share className="inline h-3.5 w-3.5 align-text-bottom" /> «Поделиться» —
                квадрат со стрелкой внизу экрана
              </li>
              <li>Выберите «На экран „Домой“»</li>
            </ol>
          </div>
        ) : canInstall ? (
          <>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Нажмите кнопку — браузер спросит подтверждение, и Qabyl появится среди приложений.
            </p>
            <Button className="mt-3" onClick={install}>
              {handheld ? (
                <Smartphone className="mr-1.5 h-4 w-4" />
              ) : (
                <Monitor className="mr-1.5 h-4 w-4" />
              )}
              Установить приложение
            </Button>
          </>
        ) : (
          <div className="mt-1 space-y-2 text-sm text-muted-foreground">
            <p>Этот браузер не предлагает установку. Поставить всё равно можно:</p>
            <ul className="ml-4 list-disc space-y-1">
              <li>
                Chrome или Edge: меню <span className="font-medium">⋮</span> → «Установить Qabyl»
                (на компьютере — значок с монитором справа в адресной строке)
              </li>
              <li>Firefox: установка не поддерживается — откройте Qabyl в Chrome</li>
            </ul>
            <p>
              Если кнопка не появилась, а приложение уже установлено — просто откройте его с
              рабочего стола.
            </p>
          </div>
        )}
      </Step>

      <Step
        n={2}
        done={push === "granted"}
        title="Разрешить уведомления"
        icon={<Bell className="h-5 w-5 text-primary" />}
      >
        {push === "granted" ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            Уведомления включены. Пришлём, как только у вас появится новая запись.
          </p>
        ) : push === "denied" ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            Уведомления заблокированы для этого сайта в настройках браузера — сам сайт их обратно
            включить не может. Откройте настройки сайта (значок слева от адреса) и разрешите
            уведомления, затем вернитесь сюда.
          </p>
        ) : push === "unsupported" ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {isIos && !installed
              ? "Сначала добавьте Qabyl на экран «Домой» — до этого iPhone не умеет присылать уведомления с сайтов."
              : "Этот браузер не поддерживает уведомления. Откройте Qabyl в Chrome."}
          </p>
        ) : (
          <>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Чтобы не открывать кабинет каждые полчаса: о новой записи, переносе и отмене сообщим
              сами.
            </p>
            <Button className="mt-3" onClick={allowNotifications} disabled={busy}>
              <BellRing className="mr-1.5 h-4 w-4" />
              {busy ? "Включаем…" : "Разрешить уведомления"}
            </Button>
          </>
        )}
      </Step>
    </div>
  );
}
