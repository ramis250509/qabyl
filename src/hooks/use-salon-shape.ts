// Один вопрос, на который отвечает весь интерфейс: сеть это или одна точка.
//
// ЗАЧЕМ. Слово «филиал» — из словаря сетей. Владелице одной студии оно ничего не объясняет, зато
// добавляет к каждому экрану лишний выпадающий список («Все филиалы» из одного пункта), лишнюю
// колонку в таблице и лишний вопрос «а это я что, что-то не настроила?». При этом внутри база
// устроена правильно: филиал есть всегда, у салона с одной точкой он просто один.
//
// РЕШЕНИЕ — не две версии приложения, а один флаг. `isMulti` = филиалов больше одного. Пока он
// false, интерфейс не произносит слово «филиал» вообще. Владелец заводит второй — и переключатели,
// фильтры и колонки появляются сами, без настроек и без миграции данных.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ХУК, А НЕ ПОЛЕ В use-branch-filter. Фильтры нужны экранам со списками
// (календарь, статистика). Настройкам салона они не нужны — там нет «активного просмотра», но
// вопрос «показывать ли слово филиал» стоит ровно так же.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type SalonBranch = {
  id: string;
  name: string;
  address: string | null;
  is_active: boolean;
};

export type SalonShape = {
  branches: SalonBranch[];
  /** Больше одной точки — интерфейс говорит «филиал». */
  isMulti: boolean;
  /** Единственная (или первая) точка. Для салона с одной точкой это «сам салон». */
  mainBranchId: string | null;
  loading: boolean;
  reload: () => void;
};

export function useSalonShape(salonId: string | null | undefined): SalonShape {
  const [branches, setBranches] = useState<SalonBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!salonId) {
      setBranches([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    supabase
      .from("branches")
      .select("id, name, address, is_active")
      .eq("salon_id", salonId)
      .eq("is_active", true)
      .order("sort_order")
      .then(({ data }) => {
        if (cancelled) return;
        setBranches((data ?? []) as SalonBranch[]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [salonId, nonce]);

  return {
    branches,
    isMulti: branches.length > 1,
    mainBranchId: branches[0]?.id ?? null,
    loading,
    reload,
  };
}
