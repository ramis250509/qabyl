import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { MapPin, Building2, AlertTriangle } from "lucide-react";
import type { useAdminFilters } from "@/hooks/use-branch-filter";

type Filters = ReturnType<typeof useAdminFilters>;

export function BranchFilterBar({ filters, showSalon = true, allowAllSalons = true }: { filters: Filters; showSalon?: boolean; allowAllSalons?: boolean }) {
  const { salons, branches, salonId, branchId, setSalonId, setBranchId, currentSalon, currentBranch, isSuperAdmin, isMaster } = filters;

  // Master is locked to a single branch — hide both selectors.
  const lockedMaster = isMaster && !isSuperAdmin;
  const effectiveAllow = allowAllSalons && isSuperAdmin;
  const multiSalon = salons.length > 1 && isSuperAdmin;
  const showBranchSelect = !lockedMaster && salonId !== "all" && branches.length > 0;

  return (
    <Card className="p-3 sm:p-4 border-2 border-primary/30 bg-primary/5 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {showSalon && multiSalon && (
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <Select value={salonId === "all" && !effectiveAllow ? (salons[0]?.id ?? "all") : salonId} onValueChange={setSalonId}>
              <SelectTrigger className="w-48 sm:w-56"><SelectValue placeholder="Салон" /></SelectTrigger>
              <SelectContent>
                {effectiveAllow && <SelectItem value="all">Все салоны</SelectItem>}
                {salons.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        {showBranchSelect && (
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger className="w-56"><SelectValue placeholder="Филиал" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все филиалы</SelectItem>
                {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {(isSuperAdmin || showBranchSelect) && (
        <div className="flex items-start gap-2 rounded-md bg-amber-100 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 p-2.5 text-amber-900 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="text-sm leading-tight">
            <span className="font-semibold">Активный просмотр:</span>{" "}
            <span>
              {salonId === "all"
                ? "Все салоны"
                : currentSalon?.name ?? "Салон"}
              {branchId !== "all" && currentBranch && (
                <> · Филиал «{currentBranch.name}»{currentBranch.address ? ` (${currentBranch.address})` : ""}</>
              )}
              {branchId === "all" && showBranchSelect && <> · все филиалы</>}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
