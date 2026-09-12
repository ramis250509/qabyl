// Общий логин для мастеров — запасной путь, когда у мастера нет почты.
//
// ЗАЧЕМ ОН ВООБЩЕ. Основной способ дать доступ — пригласить по email (карточка выше): у каждого
// свой аккаунт, пароль знает только он, отозвать можно точечно. Но в салонах региона половина
// мастеров почтой не пользуется, и владелица физически не может никого пригласить. Для этого
// случая есть один логин на всех: владелица заводит его сама и передаёт словами.
//
// ПОЧЕМУ ЭТОТ ЭКРАН ПЕРЕЕХАЛ СЮДА. Раньше он жил в «Салон → Филиалы» за иконкой ключа — то есть в
// разделе про адреса и часы работы. Найти его там мог только тот, кто уже знал, что он там есть.
// Доступы теперь в одном месте: во вкладке «Команда», рядом с приглашениями.
//
// ОДИН КОМПОНЕНТ НА ДВА СЛУЧАЯ. Салон с одной точкой получает один логин на салон; сеть — по
// логину на точку, потому что мастер должен видеть календарь своей точки, а не всей сети.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { humanError } from "@/lib/human-error";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Copy, KeyRound, Trash2, UserPlus, ChevronDown } from "lucide-react";
import {
  createSalonMaster,
  listSalonMasters,
  revokeSalonMaster,
} from "@/lib/salon-masters.functions";
import {
  createBranchMaster,
  listBranchMasters,
  revokeBranchMaster,
} from "@/lib/branch-masters.functions";
import type { SalonBranch } from "@/hooks/use-salon-shape";

type Row = { id: string; email: string; createdAt: string };

export function SharedMasterLoginsCard({
  salonId,
  branches,
  isMulti,
}: {
  salonId: string;
  branches: SalonBranch[];
  isMulti: boolean;
}) {
  const listSalon = useServerFn(listSalonMasters);
  const createSalon = useServerFn(createSalonMaster);
  const revokeSalon = useServerFn(revokeSalonMaster);
  const listBranch = useServerFn(listBranchMasters);
  const createBranch = useServerFn(createBranchMaster);
  const revokeBranch = useServerFn(revokeBranchMaster);

  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [branchId, setBranchId] = useState<string>("");
  const [creds, setCreds] = useState<{ email: string; password: string } | null>(null);

  useEffect(() => {
    if (isMulti && !branchId && branches[0]) setBranchId(branches[0].id);
  }, [isMulti, branches, branchId]);

  const load = useCallback(async () => {
    if (!open) return;
    try {
      if (isMulti) {
        if (!branchId) {
          setRows([]);
          return;
        }
        setRows((await listBranch({ data: { branchId } })) as Row[]);
      } else {
        setRows((await listSalon({ data: { salonId } })) as Row[]);
      }
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось загрузить логины"));
      setRows([]);
    }
  }, [open, isMulti, branchId, salonId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate() {
    const value = email.trim();
    if (!value) return toast.error("Введите адрес для общего логина");
    setBusy(true);
    try {
      const res: any = isMulti
        ? await createBranch({ data: { branchId, email: value } })
        : await createSalon({ data: { salonId, email: value } });
      if (res.alreadyExisted) toast.success("Такой аккаунт уже был — доступ выдан");
      else if (res.password) setCreds({ email: res.email, password: res.password });
      setEmail("");
      await load();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось создать логин"));
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(roleId: string, who: string) {
    if (!confirm(`Отозвать доступ у ${who}? Мастера больше не смогут зайти под этим логином.`))
      return;
    try {
      if (isMulti) await revokeBranch({ data: { roleId } });
      else await revokeSalon({ data: { roleId } });
      toast.success("Доступ отозван");
      await load();
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось отозвать доступ"));
    }
  }

  return (
    <Card className="p-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="qb-press flex w-full items-start justify-between gap-4 text-left"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <h2 className="font-semibold">У мастера нет почты</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Тогда заведите один логин на всех — мастера зайдут под ним и увидят только календарь и
            уведомления{isMulti ? " своей точки" : ""}.
          </p>
        </div>
        <ChevronDown
          className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="qb-rise mt-5 space-y-4 border-t pt-5">
          {isMulti && (
            <div className="space-y-1.5">
              <Label>Для какой точки</Label>
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger className="sm:max-w-xs">
                  <SelectValue placeholder="Выберите точку" />
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

          <div className="space-y-1.5">
            <Label htmlFor="shared-login-email">Придумайте адрес для общего логина</Label>
            <div className="flex gap-2">
              <Input
                id="shared-login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="mastera@vash-salon.com"
                onKeyDown={(e) => e.key === "Enter" && onCreate()}
              />
              <Button onClick={onCreate} disabled={busy} className="shrink-0">
                <UserPlus className="mr-1.5 h-4 w-4" />
                {busy ? "…" : "Создать"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Адрес может быть любым — письма на него не приходят, он нужен только как имя для
              входа. Временный пароль придумаем мы и покажем один раз: передайте его мастеру, а он
              сменит пароль сам в разделе «Аккаунт».
            </p>
          </div>

          <div className="space-y-2">
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Общих логинов пока нет.</p>
            ) : (
              rows.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.email}</p>
                    <p className="text-xs text-muted-foreground">
                      Создан {new Date(r.createdAt).toLocaleDateString("ru-RU")}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => onRevoke(r.id, r.email)}
                    aria-label={`Отозвать доступ у ${r.email}`}
                    className="shrink-0 text-muted-foreground hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <Dialog open={!!creds} onOpenChange={(o) => !o && setCreds(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4" />
              Логин готов
            </DialogTitle>
            <DialogDescription>
              Передайте эти данные мастеру — например, голосовым сообщением. Пароль временный:
              мастер может сменить его в кабинете, в разделе «Аккаунт». Показываем его один раз,
              потом останется только создать логин заново.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <CopyRow label="Логин" value={creds?.email ?? ""} />
            <CopyRow label="Пароль" value={creds?.password ?? ""} mono />
            <Button className="w-full" onClick={() => setCreds(null)}>
              Записала, готово
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function CopyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input value={value} readOnly className={mono ? "font-mono" : undefined} />
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
