import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";

let intentionalSignOut = false;

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export async function signOutFromApp() {
  intentionalSignOut = true;
  try {
    await supabase.auth.signOut();
  } finally {
    window.setTimeout(() => {
      intentionalSignOut = false;
    }, 2000);
  }
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [isSalonAdmin, setIsSalonAdmin] = useState(false);
  const [isMaster, setIsMaster] = useState(false);
  const [salonId, setSalonId] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);

  // Cold start (особенно после свайпа на мобиле) — localStorage может
  // отдавать сессию с задержкой. Пока первичный getSession() не вернулся,
  // нельзя интерпретировать ранние null-события как logout, иначе
  // роутер мгновенно редиректит на /auth и затирает состояние.
  const initialized = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function readSessionWithRetry() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session || attempt === 2) return session ?? null;
        await wait(attempt === 0 ? 150 : 350);
      }
      return null;
    }

    async function loadRoles(uid: string) {
      setRolesLoading(true);
      let { data, error } = await supabase
        .from("user_roles")
        .select("role, salon_id, branch_id")
        .eq("user_id", uid);
      if (error && !cancelled) {
        await wait(350);
        const retry = await supabase
          .from("user_roles")
          .select("role, salon_id, branch_id")
          .eq("user_id", uid);
        data = retry.data;
      }
      if (cancelled) return;
      const roles = data ?? [];
      const sa = roles.some((r: any) => r.role === "super_admin");
      const salonRole = roles.find((r: any) => r.role === "salon_admin");
      const masterRole = roles.find((r: any) => r.role === "master");
      setIsSuperAdmin(sa);
      setIsSalonAdmin(!!salonRole);
      setIsMaster(!!masterRole);
      setSalonId(salonRole?.salon_id ?? masterRole?.salon_id ?? null);
      setBranchId(masterRole?.branch_id ?? null);
      setRolesLoading(false);
    }

    function clearRoles() {
      setIsSuperAdmin(false);
      setIsSalonAdmin(false);
      setIsMaster(false);
      setSalonId(null);
      setBranchId(null);
      setRolesLoading(false);
    }

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      // Игнорируем ранние события до завершения первичной проверки сессии,
      // кроме явных идентификационных переходов.
      if (!initialized.current && event !== "SIGNED_IN" && event !== "SIGNED_OUT") {
        return;
      }
      if (event === "SIGNED_OUT" && !intentionalSignOut) {
        window.setTimeout(async () => {
          if (cancelled) return;
          const restoredSession = await readSessionWithRetry();
          if (cancelled) return;
          const restoredUser = restoredSession?.user ?? null;
          setUser(restoredUser);
          if (restoredUser) await loadRoles(restoredUser.id);
          else clearRoles();
          initialized.current = true;
          setLoading(false);
        }, 500);
        return;
      }
      const u = session?.user ?? null;
      setUser(u);
      if (u) {
        setTimeout(() => { if (!cancelled) loadRoles(u.id); }, 0);
      } else if (event === "SIGNED_OUT" || initialized.current) {
        clearRoles();
      }
    });

    // Строго дожидаемся ответа getSession() перед тем как разрешить редирект.
    readSessionWithRetry().then(async (session) => {
      if (cancelled) return;
      const u = session?.user ?? null;
      setUser(u);
      if (u) {
        await loadRoles(u.id);
      } else {
        clearRoles();
      }
      initialized.current = true;
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      initialized.current = true;
      setLoading(false);
      setRolesLoading(false);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { user, loading, rolesLoading, isSuperAdmin, isSalonAdmin, isMaster, salonId, branchId };
}
