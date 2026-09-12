// Вход, регистрация и восстановление пароля.
//
// ЧТО ЗДЕСЬ ИЗМЕНИЛОСЬ И ПОЧЕМУ. Прежний экран назывался «Регистрация супер-админа» и выдавал
// роль super_admin первому зарегистрировавшемуся, а всем остальным — ничего. Второй человек,
// создавший аккаунт, попадал на «Нет доступа» и упирался в тупик: завести салон он не мог, потому
// что INSERT на `salons` открыт только политике super_admin. Тот код к тому же не работал и для
// первого: вставка в user_roles из браузера тоже упирается в ту же политику.
//
// Теперь регистрация — это регистрация ВЛАДЕЛЬЦА САЛОНА, и она ведёт в мастер настройки, где
// салон заводится функцией create_salon_for_owner. Владелец платформы заводится один раз руками
// в базе; отдельного экрана для этого не нужно, а публичная кнопка «стать супер-админом» — это
// дыра, которая до сих пор не выстрелила только потому, что RLS её не пускала.
//
// Восстановление пароля живёт здесь же, а не отдельным маршрутом: Supabase возвращает человека по
// ссылке из письма с recovery-сессией, и разводить это по двум экранам значит завести второй путь
// туда же.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Check, Eye, EyeOff, Mail } from "lucide-react";
import { SkeletonBlock } from "@/components/ui/status";

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [{ title: "Регистрация — Qabyl" }] }),
  // `?mode=login` — для ссылки «Войти» с посадочной и из писем. Поле возвращается только когда
  // оно есть: обязательный параметр потребовал бы дописывать его в каждую существующую ссылку.
  validateSearch: (search: Record<string, unknown>): { mode?: "login" } =>
    search.mode === "login" ? { mode: "login" } : {},
  component: AuthPage,
});

/**
 * Кто к нам пришёл: новый человек или тот, кто уже заходил.
 *
 * ЗАЧЕМ. Экран по умолчанию показывал «Вход». Для человека, который первый раз открыл Qabyl по
 * ссылке из рекламы, это тупик наоборот: форма просит пароль, которого у него нет, а ссылка
 * «Нет аккаунта? Создать» — самая мелкая надпись на странице. Первый экран продукта должен
 * предлагать начать, а не доказывать, что ты уже клиент.
 *
 * ПОЧЕМУ НЕ ПРОСТО «ВСЕГДА РЕГИСТРАЦИЯ». Владелица заходит в кабинет каждый день, и подсовывать
 * ей форму регистрации — это тот же промах, только в другую сторону. Отметка ставится после
 * первого успешного входа и живёт в браузере: на своём телефоне человек видит «Вход», на чужом
 * или новом — «Создайте аккаунт».
 */
const RETURNING_KEY = "qb_returning";

function isReturningVisitor(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(RETURNING_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberVisitor() {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(RETURNING_KEY, "1");
  } catch {
    // Приватный режим. Человек просто увидит регистрацию — не поломка.
  }
}

type Mode = "login" | "signup" | "forgot" | "reset" | "check-inbox";

/** Понятная причина вместо английского текста Supabase. */
function humanAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "Неверный email или пароль";
  if (m.includes("email not confirmed")) return "Подтвердите email — письмо уже у вас на почте";
  if (m.includes("user already registered") || m.includes("already been registered"))
    return "Такой email уже зарегистрирован. Войдите или восстановите пароль.";
  if (m.includes("password should be at least"))
    return "Пароль слишком короткий — нужно минимум 8 символов";
  if (m.includes("rate limit") || m.includes("too many"))
    return "Слишком много попыток подряд. Подождите минуту и попробуйте снова.";
  if (m.includes("unable to validate email")) return "Проверьте, правильно ли написан email";
  return message;
}

function AuthPage() {
  const navigate = useNavigate();
  const { mode: modeFromUrl } = Route.useSearch();
  const [mode, setMode] = useState<Mode>(() =>
    modeFromUrl === "login" || isReturningVisitor() ? "login" : "signup",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // Ссылка из письма о сбросе приводит сюда с recovery-сессией. Отличить её от обычного входа
    // можно только по хешу: сессия в обоих случаях валидная, и без этой проверки человек молча
    // улетел бы в кабинет, так и не сменив пароль.
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    if (hash.includes("type=recovery")) {
      setMode("reset");
      setChecking(false);
      return;
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      if (session) {
        rememberVisitor();
        navigate({ to: "/admin", replace: true });
        return;
      }
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        rememberVisitor();
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: window.location.origin + "/onboarding" },
        });
        if (error) throw error;

        // Проект может требовать подтверждение почты, а может не требовать — от этого зависит,
        // есть ли сессия прямо сейчас. Разница видна пользователю, и молчать о ней нельзя:
        // в первом случае его ждёт письмо, во втором — сразу настройка.
        if (!data.session) {
          setMode("check-inbox");
          return;
        }
        navigate({ to: "/onboarding", replace: true });
        return;
      }

      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: window.location.origin + "/auth",
        });
        if (error) throw error;
        // Намеренно НЕ говорим, существует ли такой аккаунт: иначе форма превращается в
        // проверялку чужих адресов.
        setMode("check-inbox");
        return;
      }

      if (mode === "reset") {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        toast.success("Пароль изменён");
        navigate({ to: "/admin", replace: true });
        return;
      }

      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      rememberVisitor();
      navigate({ to: "/admin", replace: true });
    } catch (err: any) {
      toast.error(humanAuthError(err?.message ?? String(err)));
    } finally {
      setLoading(false);
    }
  }

  // Пока проверяем сессию, показываем каркас формы, а не пустоту. Возврат null давал белый экран
  // на всё время запроса — на медленной сети это секунда-две, и выглядит она как «сайт не
  // открылся», а не как «идёт загрузка».
  if (checking) {
    return (
      <Shell>
        <div className="space-y-4">
          <SkeletonBlock className="h-7 w-24" />
          <SkeletonBlock className="h-4 w-3/4" />
          <SkeletonBlock className="mt-6 h-10 w-full" />
          <SkeletonBlock className="h-10 w-full" />
          <SkeletonBlock className="h-11 w-full" />
        </div>
      </Shell>
    );
  }

  if (mode === "check-inbox") {
    return (
      <Shell>
        <div className="qb-rise text-center">
          <div className="qb-pop mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-info-surface">
            <Mail className="h-7 w-7 text-info" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Проверьте почту</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Мы отправили письмо на <span className="font-medium text-foreground">{email}</span>.
            Откройте его и перейдите по ссылке — она вернёт вас сюда.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Письма нет через пару минут? Загляните в «Спам» или в «Промоакции».
          </p>
          <Button
            variant="ghost"
            className="mt-6 w-full text-muted-foreground"
            onClick={() => setMode("login")}
          >
            Вернуться ко входу
          </Button>
        </div>
      </Shell>
    );
  }

  const copy = {
    login: {
      title: "Вход",
      subtitle: "Кабинет салона: записи, мастера, ассистент",
      submit: "Войти",
    },
    signup: {
      title: "Создайте аккаунт",
      subtitle: "Пять минут — и салон принимает записи онлайн",
      submit: "Начать бесплатно",
    },
    forgot: {
      title: "Восстановление пароля",
      subtitle: "Пришлём ссылку для входа на вашу почту",
      submit: "Отправить ссылку",
    },
    reset: {
      title: "Новый пароль",
      subtitle: "Придумайте пароль, с которым будете заходить",
      submit: "Сохранить пароль",
    },
  }[mode];

  const needsEmail = mode !== "reset";
  const needsPassword = mode !== "forgot";

  return (
    <Shell>
      <div className="qb-rise">
        <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">{copy.subtitle}</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {needsEmail && (
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ fontSize: 16 }}
              />
            </div>
          )}

          {needsPassword && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Пароль</Label>
                {mode === "login" && (
                  <button
                    type="button"
                    onClick={() => setMode("forgot")}
                    className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Забыли пароль?
                  </button>
                )}
              </div>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{ fontSize: 16 }}
                  className="pr-10"
                />
                {/* Показать пароль — не украшение: на телефоне это главная причина, по которой
                    человек не может войти и уходит. */}
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {(mode === "signup" || mode === "reset") && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Check
                    className={`h-3.5 w-3.5 ${password.length >= 8 ? "text-success" : "text-muted-foreground/40"}`}
                  />
                  Минимум 8 символов
                </p>
              )}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={loading} size="lg">
            {loading ? "Подождите…" : copy.submit}
          </Button>
        </form>

        <div className="mt-6 text-center text-sm">
          {mode === "login" && (
            <button
              type="button"
              className="text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setMode("signup")}
            >
              Нет аккаунта? <span className="font-medium text-foreground">Создать</span>
            </button>
          )}
          {mode === "signup" && (
            <button
              type="button"
              className="text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setMode("login")}
            >
              Уже есть аккаунт? <span className="font-medium text-foreground">Войти</span>
            </button>
          )}
          {mode === "forgot" && (
            <button
              type="button"
              className="text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setMode("login")}
            >
              Вспомнили? <span className="font-medium text-foreground">Войти</span>
            </button>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-[100dvh] items-center justify-center bg-muted/30 px-4"
      style={{
        paddingTop: "max(env(safe-area-inset-top), 1rem)",
        paddingBottom: "max(env(safe-area-inset-bottom), 1rem)",
      }}
    >
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <span className="text-lg font-bold">Qabyl</span>
        </div>
        <Card className="p-8">{children}</Card>
      </div>
    </div>
  );
}
