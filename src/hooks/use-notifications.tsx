import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type AppNotification = {
  id: string;
  salon_id: string;
  branch_id: string | null;
  appointment_id: string | null;
  type: string;
  title: string;
  body: string | null;
  is_read: boolean;
  created_at: string;
};

/**
 * Subscribes to the notifications table and exposes a live list plus
 * helpers to mark items read. Also requests browser notification permission
 * once and shows a desktop push on new inserts (works while the tab is
 * open or minimized — no service worker required).
 */
export function useNotifications(opts: { salonId: string | null; isSuperAdmin: boolean; branchId?: string | null }) {
  const { salonId, isSuperAdmin, branchId } = opts;
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      // Best-effort cleanup of notifications older than 7 days
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      let del = supabase.from("notifications").delete().lt("created_at", cutoff);
      if (!isSuperAdmin && salonId) del = del.eq("salon_id", salonId);
      await del;

      let q = supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(100);
      if (!isSuperAdmin && salonId) q = q.eq("salon_id", salonId);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data } = await q;

      setItems((data ?? []) as AppNotification[]);
    } finally {
      setLoading(false);
    }
  }, [salonId, isSuperAdmin, branchId]);

  // Ask permission once.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!isSuperAdmin && !salonId) return;
    fetchAll();
    const channelName = `notifications-${salonId ?? "all"}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const filter = salonId && !isSuperAdmin ? { filter: `salon_id=eq.${salonId}` } : {};
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", ...filter },
        (payload) => {
          const n = payload.new as AppNotification;
          // Defensive tenant isolation: drop any event outside current salon/branch scope.
          if (!isSuperAdmin && salonId && n.salon_id !== salonId) return;
          if (branchId && n.branch_id && n.branch_id !== branchId) return;
          setItems((prev) => (prev.some((p) => p.id === n.id) ? prev : [n, ...prev]));
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "notifications", ...filter },
        (payload) => {
          const n = payload.new as AppNotification;
          if (!isSuperAdmin && salonId && n.salon_id !== salonId) return;
          if (branchId && n.branch_id && n.branch_id !== branchId) return;
          setItems((prev) => prev.map((p) => (p.id === n.id ? { ...p, ...n } : p)));
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "notifications", ...filter },
        (payload) => {
          const id = (payload.old as any)?.id;
          if (id) setItems((prev) => prev.filter((p) => p.id !== id));
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [salonId, isSuperAdmin, branchId, fetchAll]);

  const unreadCount = items.filter((i) => !i.is_read).length;

  const markRead = async (id: string) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, is_read: true } : i)));
    await supabase.from("notifications").update({ is_read: true }).eq("id", id);
  };

  const markAllRead = async () => {
    const ids = items.filter((i) => !i.is_read).map((i) => i.id);
    if (ids.length === 0) return;
    setItems((prev) => prev.map((i) => ({ ...i, is_read: true })));
    await supabase.from("notifications").update({ is_read: true }).in("id", ids);
  };

  return { items, loading, unreadCount, markRead, markAllRead, refresh: fetchAll };
}
