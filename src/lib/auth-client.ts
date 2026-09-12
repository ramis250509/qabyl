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
  // Роль «Администратор» (manager) — человек на ресепшене: календарь, записи, переписки, без
  // настроек, цен и статистики. Она была заведена в базе и в политиках RLS, но здесь её не
  // читали: такой сотрудник получал все флаги false, кабинет считал его человеком без роли и
  // отправлял в мастер создания салона — то есть предлагал завести второй салон вместо работы
  // в том, куда его позвали.
  const [isManager, setIsManager] = useState(false);
  const [isMaster, setIsMaster] = useState(false);
  const [salonId, setSalonId] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);

  // Cold start (особенно после свайпа на мобиле) — localStorage может
  // отдавать сессию с задержкой. Пока первичный getSession() не вернулся,
  // нельзя интерпретировать ранние null-события как logout, иначе
  // роутер мгновенно редиректит на /auth и затирает состояние.
  const initialized = useRef(false);
  // Текущий id пользователя, отражённый в состоянии, и id, для которого уже
  // загружены роли. Нужны, чтобы token-refresh / повторные SIGNED_IN при
  // возврате на вкладку (PWA resume) НЕ пересоздавали объект user и НЕ
  // перезапрашивали роли — иначе каскад ре-рендеров выглядит как «перезагрузка».
  const currentUidRef = useRef<string | null>(null);
  const rolesUidRef = useRef<string | null>(null);

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
      const managerRole = roles.find((r: any) => r.role === "manager");
      const masterRole = roles.find((r: any) => r.role === "master");
      setIsSuperAdmin(sa);
      setIsSalonAdmin(!!salonRole);
      setIsManager(!!managerRole);
      setIsMaster(!!masterRole);
      setSalonId(salonRole?.salon_id ?? managerRole?.salon_id ?? masterRole?.salon_id ?? null);
      setBranchId(masterRole?.branch_id ?? null);
      setRolesLoading(false);
    }

    function clearRoles() {
      setIsSuperAdmin(false);
      setIsSalonAdmin(false);
      setIsManager(false);
      setIsMaster(false);
      setSalonId(null);
      setBranchId(null);
      setRolesLoading(false);
    }

    // Применяет пользователя из сессии, НЕ создавая лишних ре-рендеров:
    // объект user меняем только при смене id, роли грузим только для нового id.
    function applyUser(u: User | null) {
      const uid = u?.id ?? null;
      if (uid !== currentUidRef.current) {
        currentUidRef.current = uid;
        setUser(u);
      }
      if (uid) {
        if (rolesUidRef.current !== uid) {
          rolesUidRef.current = uid;
          setTimeout(() => {
            if (!cancelled) loadRoles(uid);
          }, 0);
        }
      } else {
        rolesUidRef.current = null;
        clearRoles();
      }
    }

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      // Token-refresh при возврате на вкладку не меняет ни пользователя, ни роли —
      // полностью игнорируем, чтобы не дёргать состояние.
      if (event === "TOKEN_REFRESHED") return;
      // Игнорируем ранние события до завершения первичной проверки сессии,
      // кроме явных идентификационных переходов.
      if (!initialized.current && event !== "SIGNED_IN" && event !== "SIGNED_OUT") {
        return;
      }
      if (event === "SIGNED_OUT" && !intentionalSignOut) {
        // Транзиентный SIGNED_OUT (частый на мобильном PWA при resume). Не
        // сбрасываем состояние сразу — сперва перепроверяем сессию; если она
        // жива, applyUser увидит тот же id и НЕ вызовет ни setUser, ни reload
        // (никакого «мигания»). Чистим только если сессии реально нет.
        window.setTimeout(async () => {
          if (cancelled) return;
          const restoredSession = await readSessionWithRetry();
          if (cancelled) return;
          applyUser(restoredSession?.user ?? null);
          initialized.current = true;
          setLoading(false);
        }, 500);
        return;
      }
      applyUser(session?.user ?? null);
    });

    // Строго дожидаемся ответа getSession() перед тем как разрешить редирект.
    readSessionWithRetry().then((session) => {
      if (cancelled) return;
      applyUser(session?.user ?? null);
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

  return {
    user,
    loading,
    rolesLoading,
    isSuperAdmin,
    isSalonAdmin,
    isManager,
    isMaster,
    salonId,
    branchId,
  };
}
