// «Этот канал — для всей сети или для одной точки?»
//
// Вопрос задаётся только сети. У салона с одной точкой ответ известен заранее, и спрашивать его
// значит завести владельца в термин «филиал», которого он в своём кабинете больше нигде не видит
// (см. use-salon-shape.ts — там то же правило для всего кабинета).
//
// Спрашиваем ДО подключения, а не после: решение «этот номер будет для точки на Чуй» принимается,
// когда человек думает о точках, а не в середине окна Meta, где думать уже некогда.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { humanError } from "@/lib/human-error";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Building2, MapPin } from "lucide-react";
import {
  assignHistoryToBranch,
  countUnassignedConversations,
  setChannelScope,
} from "@/lib/channels.functions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { SalonBranch } from "@/hooks/use-salon-shape";
import { plural } from "@/lib/billing-logic";

export function ChannelScopePicker({
  salonId,
  kind,
  branches,
  initialScope,
  initialBranchId,
}: {
  salonId: string;
  kind: "whatsapp" | "instagram";
  branches: SalonBranch[];
  initialScope?: "salon" | "branch";
  initialBranchId?: string | null;
}) {
  const save = useServerFn(setChannelScope);
  const countOld = useServerFn(countUnassignedConversations);
  const moveOld = useServerFn(assignHistoryToBranch);
  // Предложение перенести историю. Появляется один раз — после того, как канал закрепили за
  // точкой и выяснилось, что старые переписки остались без неё.
  const [offer, setOffer] = useState<{ count: number; branchId: string } | null>(null);
  const [moving, setMoving] = useState(false);
  const [scope, setScope] = useState<"salon" | "branch">(initialScope ?? "salon");
  const [branchId, setBranchId] = useState<string>(initialBranchId ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialScope) setScope(initialScope);
    if (initialBranchId) setBranchId(initialBranchId);
  }, [initialScope, initialBranchId]);

  // Сеть — от двух точек. Одна точка вопроса не порождает.
  if (branches.length < 2) return null;

  async function apply(next: "salon" | "branch", nextBranch?: string) {
    const b = nextBranch ?? branchId ?? branches[0]?.id ?? "";
    setScope(next);
    if (next === "branch" && !b) return;
    setBusy(true);
    try {
      await save({
        data: { salonId, kind, scope: next, branchId: next === "branch" ? b : null },
      });
      toast.success(
        next === "salon"
          ? "Канал общий: ассистент спросит клиента, в какую точку записать"
          : `Канал закреплён за точкой «${branches.find((x) => x.id === b)?.name ?? ""}»`,
      );

      // Старые переписки пришли тогда, когда точки ещё не различали, и остались без неё. Если
      // их не тронуть, в статистике будет обрыв: до сегодня у точки ноль обращений, после —
      // все. Спрашиваем, а не решаем за владельца: его прошлое, ему и решать.
      if (next === "branch") {
        try {
          const { count } = await countOld({ data: { salonId, kind } });
          if (count > 0) setOffer({ count, branchId: b });
        } catch {
          // Не смогли посчитать — молчим. Предложение переноса не стоит того, чтобы показывать
          // ошибку поверх удачно сохранённой настройки.
        }
      }
    } catch (e: any) {
      toast.error(humanError(e, "Не удалось сохранить"));
    } finally {
      setBusy(false);
    }
  }

  const options = [
    {
      key: "salon" as const,
      icon: Building2,
      title: "Для всей сети",
      hint: "Ассистент спросит клиента, в какую точку он хочет",
    },
    {
      key: "branch" as const,
      icon: MapPin,
      title: "Для одной точки",
      hint: "Только её услуги, мастера и свободное время",
    },
  ];

  return (
    <Card className="space-y-3 p-4 sm:p-6">
      <div>
        <h3 className="font-semibold">Кому принадлежит этот канал</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          У вас несколько точек. От этого зависит, что ассистент предложит клиенту, который сюда
          напишет.
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label="Область действия канала"
        className="grid gap-2 sm:grid-cols-2"
      >
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={scope === o.key}
            disabled={busy}
            onClick={() => apply(o.key)}
            className={`qb-press rounded-lg border p-3 text-left ${
              scope === o.key
                ? "border-primary bg-primary/5 ring-1 ring-primary"
                : "hover:border-primary/40 hover:bg-muted/40"
            }`}
          >
            <span className="flex items-center gap-2">
              <o.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-sm font-medium">{o.title}</span>
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">{o.hint}</span>
          </button>
        ))}
      </div>

      {scope === "branch" && (
        <div className="space-y-1.5">
          <Label>Какая точка</Label>
          <Select
            value={branchId}
            onValueChange={(v) => {
              setBranchId(v);
              void apply("branch", v);
            }}
          >
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

      <AlertDialog open={!!offer} onOpenChange={(o) => !o && setOffer(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Перенести прошлые переписки?</AlertDialogTitle>
            <AlertDialogDescription>
              {offer?.count} {plural(offer?.count ?? 0, "переписка", "переписки", "переписок")} в
              этом канале пришли до того, как вы закрепили его за точкой «
              {branches.find((x) => x.id === offer?.branchId)?.name ?? ""}», и точки у них нет. Если
              не перенести, в статистике будет разрыв: до сегодня у точки ноль обращений, после —
              все.
              <br />
              <br />
              Переписки, где клиент сам выбрал другую точку, останутся на своих местах.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={moving}>Оставить как есть</AlertDialogCancel>
            <AlertDialogAction
              disabled={moving}
              onClick={async (e) => {
                e.preventDefault();
                if (!offer) return;
                setMoving(true);
                try {
                  const r = await moveOld({
                    data: { salonId, kind, branchId: offer.branchId },
                  });
                  toast.success(
                    `Перенесено: ${r.moved} ${plural(r.moved, "переписка", "переписки", "переписок")}`,
                  );
                  setOffer(null);
                } catch (err: any) {
                  toast.error(humanError(err, "Не удалось перенести"));
                } finally {
                  setMoving(false);
                }
              }}
            >
              {moving ? "Переносим…" : "Перенести"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
