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
import { Trash2, UserPlus, Users } from "lucide-react";
import {
  inviteEmployee,
  listSalonEmployees,
  revokeEmployeeAccess,
  setStaffIsolation,
} from "@/lib/rbac.functions";
import { useAuth } from "@/lib/auth-client";
import { useSalonShape } from "@/hooks/use-salon-shape";
import { SharedMasterLoginsCard } from "@/components/admin/SharedMasterLoginsCard";

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
  const setIsolation = useServerFn(setStaffIsolation);

  // Филиалы читаются общим хуком: он же решает, произносит ли интерфейс слово «филиал».
  const { branches, isMulti } = useSalonShape(salonId);

  const [rows, setRows] = useState<Employee[] | null>(null);
  const [isolation, setIsolationState] = useState(false);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("manager");
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
          // Без этого Supabase уводит по ссылке из письма на Site URL проекта — то есть на
          // рекламную страницу Qabyl, где сотруднику предлагают зарегистрироваться заново.
          origin: typeof window !== "undefined" ? window.location.origin : null,
        },
      });
      toast.success(
        res.invited
          ? `Письмо отправлено на ${value}. По ссылке из письма сотрудник придумает пароль и сразу попадёт в кабинет.`
          : `Доступ выдан: у ${value} уже был аккаунт в Qabyl`,
      );
      setEmail("");
      await load();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось выдать доступ"));
    } finally {
      setBusy(false);
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
      <Card className="space-y-4 p-6">
        <div>
          <h2 className="font-semibold">Пригласить сотрудника</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Сотрудник получит письмо, придумает пароль и сразу попадёт в кабинет. Пароль знает
            только он. Если почты нет — ниже есть второй способ.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
          <div className="space-y-1.5">
            <Label htmlFor="employee-email">Email</Label>
            <Input
              id="employee-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="master@salon.com"
              onKeyDown={(e) => e.key === "Enter" && onInvite()}
            />
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

        <Button onClick={onInvite} disabled={busy}>
          <UserPlus className="mr-1.5 h-4 w-4" />
          {busy ? "Отправляем…" : "Пригласить"}
        </Button>
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
              <li key={r.id} className="flex items-center gap-3 px-6 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.email}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {r.linkedMaster
                      ? `Профиль мастера: ${r.linkedMaster.name}`
                      : "Без профиля мастера"}
                  </p>
                </div>
                <StatusBadge tone={roleTone(r.role)}>{r.roleLabel}</StatusBadge>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onRevoke(r)}
                  disabled={busy}
                  aria-label={`Отозвать доступ у ${r.email}`}
                  className="shrink-0 text-muted-foreground hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Настройка принадлежит владельцу: в базе на неё стоит триггер, и у администратора
          она всё равно бы не сработала. Показывать выключатель, который заведомо откажет, —
          это обещание, которое интерфейс не может сдержать. */}
      {isOwner && (
        <Card className="p-6">
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

      {/* Переехало из «Салон → Филиалы»: все доступы теперь в одном месте. */}
      <SharedMasterLoginsCard salonId={salonId} branches={branches} isMulti={isMulti} />
    </div>
  );
}
