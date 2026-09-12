// Доступ сотрудников: кто может заходить в кабинет и что видит.
//
// ЗАЧЕМ ПОЯВИЛСЯ. Серверная часть — inviteEmployee, listSalonEmployees, revokeEmployeeAccess,
// linkMasterToUser, setStaffIsolation — существовала и была написана полностью, но экрана к ней
// не было ни одного. То есть владелец салона физически не мог дать доступ администратору на
// ресепшене или мастеру: единственный способ — письмо в поддержку. Для продукта, который продаётся
// как self-service, это дыра ровно того же размера, что и невозможность завести салон.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ ВКЛАДКИ «Доступ» ДЛЯ super_admin. Та выдаёт салону ВЛАДЕЛЬЦА и остаётся
// операцией платформы. Эта — про команду внутри уже существующего салона, и она принадлежит
// владельцу.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { humanError } from "@/lib/human-error";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, SkeletonBlock, StatusBadge } from "@/components/ui/status";
import { Copy, KeyRound, Send, Trash2, UserPlus, Users } from "lucide-react";
import {
  inviteEmployee,
  listSalonEmployees,
  resendEmployeeInvite,
  resetEmployeePassword,
  revokeEmployeeAccess,
  setStaffIsolation,
} from "@/lib/rbac.functions";
import { useAuth } from "@/lib/auth-client";
import { useSalonShape } from "@/hooks/use-salon-shape";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Employee = Awaited<ReturnType<typeof listSalonEmployees>>[number];
type Role = "salon_admin" | "manager" | "master";

/**
 * Роли на языке салона.
 *
 * `salon_admin` — не «администратор системы», а совладелец: он может всё, включая выдачу
 * доступов. Разница важна, потому что владелица регулярно хочет дать доступ «администратору»,
 * имея в виду человека на ресепшене, — а это `manager`.
 */
const ROLES: { value: Role; label: string; desc: string }[] = [
  {
    value: "manager",
    label: "Администратор",
    desc: "Календарь, записи и переписки. Без настроек, цен и статистики.",
  },
  {
    value: "master",
    label: "Мастер",
    desc: "Календарь и свои записи. Без цен, настроек и статистики.",
  },
  {
    value: "salon_admin",
    label: "Совладелец",
    desc: "Всё то же, что и у вас, включая настройки и выдачу доступов.",
  },
];

function roleTone(role: string) {
  return role === "salon_admin" ? ("warn" as const) : ("ok" as const);
}

export function TeamAccessTab({ salonId }: { salonId: string }) {
  const { isSalonAdmin, isSuperAdmin } = useAuth();
  const isOwner = isSalonAdmin || isSuperAdmin;
  const list = useServerFn(listSalonEmployees);
  const invite = useServerFn(inviteEmployee);
  const revoke = useServerFn(revokeEmployeeAccess);
  const resend = useServerFn(resendEmployeeInvite);
  const resetPassword = useServerFn(resetEmployeePassword);
  const setIsolation = useServerFn(setStaffIsolation);

  // Филиалы читаются общим хуком: он же решает, произносит ли интерфейс слово «филиал».
  const { branches, isMulti } = useSalonShape(salonId);

  const [rows, setRows] = useState<Employee[] | null>(null);
  const [isolation, setIsolationState] = useState(false);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("manager");
  // Кого мы только что позвали и ушло ли письмо. Держим на экране, а не в исчезающем тосте:
  // «письма не будет» — это указание к действию, а не уведомление.
  const [lastInvite, setLastInvite] = useState<{ email: string; emailSent: boolean } | null>(null);
  // Как выдаём доступ. «Пароль» — не запасной путь, а основной для половины салонов: у мастера
  // часто нет почты, которой он пользуется, а почтовая служба вдобавок упирается в предел писем.
  const [method, setMethod] = useState<"email" | "password">("email");
  // Показывается один раз и нигде не хранится — ни у нас, ни в базе.
  const [creds, setCreds] = useState<{ email: string; password: string } | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const [emp, salon] = await Promise.all([
        list({ data: { salonId } }),
        supabase.from("salons").select("staff_isolation").eq("id", salonId).maybeSingle(),
      ]);
      setRows(emp);
      setIsolationState(Boolean((salon.data as any)?.staff_isolation));
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось загрузить список сотрудников"));
      setRows([]);
    }
  }, [salonId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Первая точка подставляется сама: у салона с одной точкой выбирать нечего, а сервер всё равно
  // требует branch_id для роли мастера.
  useEffect(() => {
    if (!branchId && branches[0]) setBranchId(branches[0].id);
  }, [branches, branchId]);

  async function onInvite() {
    const value = email.trim();
    if (!value) return toast.error("Введите email сотрудника");
    // Мастеру филиал обязателен: без него сервер откажет валидацией, а владельцу останется
    // непонятное «branchId required». Проверяем здесь, где можно сказать по-человечески.
    if (role === "master" && !branchId) {
      return toast.error(
        isMulti
          ? "Выберите точку — мастер работает в конкретной точке"
          : "Не удалось определить салон. Обновите страницу и попробуйте снова.",
      );
    }

    setBusy(true);
    try {
      const res = await invite({
        data: {
          salonId,
          email: value,
          role,
          branchId: role === "master" ? branchId : null,
          method,
          // Без этого Supabase уводит по ссылке из письма на Site URL проекта — то есть на
          // рекламную страницу Qabyl, где сотруднику предлагают зарегистрироваться заново.
          origin: typeof window !== "undefined" ? window.location.origin : null,
        },
      });
      if (res.password) {
        setCreds({ email: value, password: res.password });
        setLastInvite(null);
        toast.success("Доступ создан — передайте логин и пароль");
      } else {
        setLastInvite({ email: value, emailSent: res.emailSent });
        toast.success(
          res.emailSent
            ? `Письмо отправлено на ${value}`
            : "Доступ выдан, но письмо не отправляли — читайте ниже",
        );
      }
      setEmail("");
      await load();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось выдать доступ"));
    } finally {
      setBusy(false);
    }
  }

  async function onResend(row: Employee) {
    setResending(row.userId);
    try {
      await resend({
        data: {
          salonId,
          userId: row.userId,
          origin: typeof window !== "undefined" ? window.location.origin : null,
        },
      });
      toast.success(`Ссылка для входа отправлена на ${row.email}`);
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось отправить письмо"));
    } finally {
      setResending(null);
    }
  }

  async function onResetPassword(row: Employee) {
    if (
      !confirm(
        `Выдать новый пароль для ${row.email}? Старый перестанет работать сразу — предупредите человека.`,
      )
    )
      return;
    setResending(row.userId);
    try {
      const res = await resetPassword({ data: { salonId, userId: row.userId } });
      setCreds({ email: row.email, password: res.password });
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось выдать новый пароль"));
    } finally {
      setResending(null);
    }
  }

  async function onRevoke(row: Employee) {
    if (!confirm(`Отозвать доступ у ${row.email}? Данные салона при этом не изменятся.`)) return;
    setBusy(true);
    try {
      await revoke({ data: { salonId, userId: row.userId, unlinkMaster: true } });
      toast.success("Доступ отозван");
      await load();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось отозвать доступ"));
    } finally {
      setBusy(false);
    }
  }

  async function onToggleIsolation(next: boolean) {
    const prev = isolation;
    setIsolationState(next);
    try {
      await setIsolation({ data: { salonId, enabled: next } });
      toast.success(
        next ? "Мастера теперь видят только свои записи" : "Мастера снова видят весь календарь",
      );
    } catch (e: any) {
      setIsolationState(prev);
      toast.error(humanError(e, "Не удалось изменить настройку"));
    }
  }

  const selectedRole = ROLES.find((r) => r.value === role)!;

  return (
    <div className="max-w-3xl space-y-4">
      <Card className="space-y-4 p-4 sm:p-6">
        <div>
          <h2 className="font-semibold">Пригласить сотрудника</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {method === "email"
              ? "Сотрудник получит письмо, придумает пароль и сразу попадёт в кабинет."
              : "Мы сразу заведём доступ и покажем пароль из 8 цифр — его можно продиктовать."}
          </p>
        </div>

        {/* Два способа рядом, а не «основной и спрятанный».

            Раньше выдача пароля жила отдельной свёрнутой карточкой внизу вкладки, под
            заголовком «У мастера нет почты». Находил её только тот, кто уже знал, что она там
            есть, — а в салонах региона это самый частый путь, а не исключение. */}
        <div role="radiogroup" aria-label="Как выдать доступ" className="grid gap-2 sm:grid-cols-2">
          {(
            [
              { key: "email", label: "Отправить письмо", hint: "Пароль придумает сам" },
              { key: "password", label: "Выдать пароль", hint: "8 цифр, скажете голосом" },
            ] as const
          ).map((m) => (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={method === m.key}
              onClick={() => setMethod(m.key)}
              className={`qb-press rounded-lg border p-3 text-left ${
                method === m.key
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "hover:border-primary/40 hover:bg-muted/40"
              }`}
            >
              <span className="block text-sm font-medium">{m.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{m.hint}</span>
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
          <div className="space-y-1.5">
            <Label htmlFor="employee-email">
              {method === "email" ? "Email сотрудника" : "Логин (любой адрес)"}
            </Label>
            <Input
              id="employee-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="master@salon.com"
              onKeyDown={(e) => e.key === "Enter" && onInvite()}
            />
            {method === "password" && (
              <p className="text-xs text-muted-foreground">
                Письма туда не ходят — адрес нужен только как имя для входа.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Роль</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">{selectedRole.desc}</p>

        {/* Точку спрашиваем только у сети. У салона с одной точкой ответ известен заранее —
            он подставлен выше, и лишний вопрос тут только пугает. */}
        {role === "master" && isMulti && (
          <div className="space-y-1.5">
            <Label>Филиал</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger className="sm:max-w-xs">
                <SelectValue placeholder="Выберите филиал" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Button onClick={onInvite} disabled={busy} size="lg" className="w-full sm:w-auto">
          <UserPlus className="mr-1.5 h-4 w-4" />
          {busy ? "Создаём…" : method === "email" ? "Отправить письмо" : "Создать доступ"}
        </Button>

        {/* Самое важное сообщение этого экрана.

            У человека уже может быть аккаунт Qabyl — он пробовал сам, или его звали в другой
            салон. Supabase в этом случае письмо не отправляет вообще, и раньше владелец видел
            бодрое «Доступ выдан» и неделю ждал сотрудника, который ничего не получал. */}
        {lastInvite && (
          <div
            className={`qb-rise rounded-lg border p-3.5 text-sm ${
              lastInvite.emailSent
                ? "border-success-border bg-success-surface"
                : "border-warning-border bg-warning-surface"
            }`}
          >
            {lastInvite.emailSent ? (
              <p>
                Письмо ушло на <span className="font-medium">{lastInvite.email}</span>. Сотрудник
                придумает пароль по ссылке и сразу попадёт в кабинет. Если письма нет — пусть
                проверит папку «Спам».
              </p>
            ) : (
              <div className="space-y-1.5">
                <p className="font-medium">Доступ выдан, но письмо мы не отправляли</p>
                <p>
                  У <span className="font-medium">{lastInvite.email}</span> уже есть аккаунт Qabyl —
                  он заходит этой почтой и своим паролем. Скажите ему об этом. Если пароль забыт,
                  нажмите «Отправить ссылку» в списке ниже.
                </p>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="p-0">
        <div className="border-b p-6 pb-4">
          <h2 className="font-semibold">Кто имеет доступ</h2>
        </div>

        {rows === null ? (
          <div className="space-y-3 p-6">
            <SkeletonBlock className="h-10 w-full" />
            <SkeletonBlock className="h-10 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Пока вы работаете одна"
            body="Пригласите администратора на ресепшен или мастера — они увидят только то, что им нужно для работы."
          />
        ) : (
          <ul className="qb-stagger divide-y">
            {rows.map((r) => (
              // На телефоне почта, роль и кнопки в одну строку не помещаются: адрес обрезался
              // до «akbar…», и отличить двух сотрудников с похожими адресами было нельзя.
              // Поэтому вертикально: адрес целиком с переносом, под ним роль и действия.
              <li key={r.id} className="px-4 py-4 sm:px-6 sm:py-3.5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-all text-sm font-medium sm:truncate">{r.email}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {r.linkedMaster
                        ? `Профиль мастера: ${r.linkedMaster.name}`
                        : "Без профиля мастера"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={roleTone(r.role)}>{r.roleLabel}</StatusBadge>
                    {!r.signedIn && <StatusBadge tone="warn">ещё не заходил</StatusBadge>}
                    <div className="ml-auto flex items-center gap-1 sm:ml-0">
                      {!r.signedIn && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onResend(r)}
                          disabled={resending === r.userId}
                        >
                          <Send className="mr-1.5 h-3.5 w-3.5" />
                          {resending === r.userId ? "Отправляем…" : "Отправить ссылку"}
                        </Button>
                      )}
                      {/* Пароль показывается один раз, и «забыл» — норма, а не исключение.
                          Без этой кнопки выход был один: отозвать доступ и завести заново,
                          потеряв привязку к профилю мастера. */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onResetPassword(r)}
                        disabled={resending === r.userId}
                      >
                        <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                        Новый пароль
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onRevoke(r)}
                        disabled={busy}
                        aria-label={`Отозвать доступ у ${r.email}`}
                        className="h-10 w-10 shrink-0 text-muted-foreground hover:text-danger"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Настройка принадлежит владельцу: в базе на неё стоит триггер, и у администратора
          она всё равно бы не сработала. Показывать выключатель, который заведомо откажет, —
          это обещание, которое интерфейс не может сдержать. */}
      {isOwner && (
        <Card className="p-4 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-semibold">Мастер видит только свои записи</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Обычно мастер видит весь календарь — так удобнее подменять друг друга. В клиниках и
                там, где записи считаются личными, это стоит выключить: тогда каждый видит только
                то, что записано на него.
              </p>
            </div>
            <Switch checked={isolation} onCheckedChange={onToggleIsolation} />
          </div>
        </Card>
      )}

      {/* Карточка «У мастера нет почты» отсюда убрана: она делала ровно то же самое, что
          теперь делает способ «Выдать пароль» в форме выше, только хуже — один логин на всех
          вместо отдельного на человека, и спрятанный так, что находил его не каждый. */}

      <Dialog open={!!creds} onOpenChange={(o) => !o && setCreds(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4" />
              Доступ готов
            </DialogTitle>
            <DialogDescription>
              Передайте сотруднику — можно продиктовать или отправить голосовым. Пароль показывается
              один раз; если потеряется, выдайте новый кнопкой в списке.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <CredRow label="Логин" value={creds?.email ?? ""} />
            <CredRow label="Пароль" value={creds?.password ?? ""} big />
            <Button className="w-full" onClick={() => setCreds(null)}>
              Записала, готово
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Строка «логин / пароль» с копированием в один тап. */
function CredRow({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input
          value={value}
          readOnly
          className={big ? "font-mono text-lg tracking-[0.2em]" : undefined}
        />
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label={`Скопировать ${label.toLowerCase()}`}
          onClick={() => {
            navigator.clipboard.writeText(value);
            toast.success("Скопировано");
          }}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
