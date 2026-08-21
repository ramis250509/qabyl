/**
 * Одно правило на весь код: в уведомлениях `branch_id IS NULL` означает
 * «относится ко всему салону», а не «ни к какому филиалу».
 *
 * Почему это отдельный модуль. Наивный `.eq("branch_id", id)` в SQL никогда не
 * совпадёт с NULL-строкой, поэтому фильтр по филиалу молча отдаёт пустой список
 * вместо «всё + филиал». Этот класс бага уже ломал публичный виджет записи
 * (см. комментарий в PublicBooking.tsx) и 21.08.2026 сломал колокольчик салона
 * «Эркеайым». Дальше — только через эти два хелпера.
 */

/** Условие для PostgREST `.or(...)`: строки салона + строки выбранного филиала. */
export function branchScopeFilter(branchId: string): string {
  return `branch_id.is.null,branch_id.eq.${branchId}`;
}

/**
 * Проходит ли строка фильтр по филиалу.
 *
 * - `null`  — «на весь салон», видно при любом фильтре;
 * - `undefined` — филиал ещё не догрузился, прятать нельзя (иначе список
 *   мигает пустотой и выглядит как «уведомления не приходят»);
 * - конкретный id — видно только в своём филиале.
 */
export function matchesBranchScope(
  rowBranchId: string | null | undefined,
  filterBranchId: string | null,
): boolean {
  if (!filterBranchId) return true;
  if (rowBranchId === null || rowBranchId === undefined) return true;
  return rowBranchId === filterBranchId;
}
