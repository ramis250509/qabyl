// Панель «что я сейчас смотрю».
//
// ЧТО ИЗМЕНИЛОСЬ И ПОЧЕМУ. Раньше она показывалась почти всегда — включая салон с одной точкой,
// где выбирать было не из чего: выпадающий список из одного пункта, «Все филиалы» поверх него и
// жёлтая плашка-предупреждение, которая ничего не предупреждала. Для владелицы одной студии это
// был первый экран продукта, и он начинался с чужого слова «филиал» и жёлтого цвета тревоги.
//
// ПРАВИЛО ТЕПЕРЬ ОДНО: панель показывается, только когда есть ЧТО выбрать. Нечего — её нет.
// Жёлтый цвет ушёл: «вы смотрите один филиал из трёх» — это не ошибка, а обычное состояние.
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MapPin, Building2 } from "lucide-react";
import type { useAdminFilters } from "@/hooks/use-branch-filter";

type Filters = ReturnType<typeof useAdminFilters>;

export function BranchFilterBar({
  filters,
  showSalon = true,
  allowAllSalons = true,
}: {
  filters: Filters;
  showSalon?: boolean;
  allowAllSalons?: boolean;
}) {
  const { salons, branches, salonId, branchId, setSalonId, setBranchId, isSuperAdmin, isMaster } =
    filters;

  // Мастер закреплён за одной точкой — выбирать ему нечего.
  const lockedMaster = isMaster && !isSuperAdmin;
  const effectiveAllow = allowAllSalons && isSuperAdmin;
  const showSalonSelect = showSalon && isSuperAdmin && salons.length > 1;
  // Ключевое условие всего пункта: филиалов должно быть БОЛЬШЕ ОДНОГО.
  const showBranchSelect = !lockedMaster && salonId !== "all" && branches.length > 1;

  if (!showSalonSelect && !showBranchSelect) return null;

  return (
    <div className="qb-fade flex flex-wrap items-center gap-2">
      {showSalonSelect && (
        <div className="relative">
          <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Select
            value={salonId === "all" && !effectiveAllow ? (salons[0]?.id ?? "all") : salonId}
            onValueChange={setSalonId}
          >
            <SelectTrigger className="w-52 pl-9 sm:w-60">
              <SelectValue placeholder="Салон" />
            </SelectTrigger>
            <SelectContent>
              {effectiveAllow && <SelectItem value="all">Все салоны</SelectItem>}
              {salons.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {showBranchSelect && (
        <div className="relative">
          <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger className="w-52 pl-9 sm:w-60">
              <SelectValue placeholder="Филиал" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все филиалы</SelectItem>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
