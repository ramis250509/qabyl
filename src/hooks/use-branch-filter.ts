import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-client";

const SALON_KEY = "zb_admin_salon_id";
const BRANCH_KEY = "zb_admin_branch_id";

export type AdminSalon = { id: string; name: string };
export type AdminBranch = { id: string; name: string; address: string | null };

function read(key: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(key);
}
function write(key: string, val: string | null) {
  if (typeof window === "undefined") return;
  if (val === null) localStorage.removeItem(key);
  else localStorage.setItem(key, val);
}

export function useAdminFilters() {
  const { isSuperAdmin, isMaster, salonId: ownSalonId, branchId: ownBranchId } = useAuth();
  const [salons, setSalons] = useState<AdminSalon[]>([]);
  const [branches, setBranches] = useState<AdminBranch[]>([]);
  const [salonId, setSalonIdState] = useState<string>(() => read(SALON_KEY) ?? "all");
  const [branchId, setBranchIdState] = useState<string>(() => read(BRANCH_KEY) ?? "all");

  useEffect(() => {
    // Master: locked to own salon — no list query.
    if (isMaster && !isSuperAdmin && ownSalonId) {
      supabase.from("salons").select("id, name").eq("id", ownSalonId).then(({ data }) => {
        const list = data ?? [];
        setSalons(list);
        if (list[0]) {
          setSalonIdState(list[0].id);
          write(SALON_KEY, list[0].id);
        }
      });
      return;
    }
    // Salon admin: only their own salon.
    if (!isSuperAdmin) {
      if (!ownSalonId) { setSalons([]); return; }
      supabase.from("salons").select("id, name").eq("id", ownSalonId).then(({ data }) => {
        const list = data ?? [];
        setSalons(list);
        if (list[0]) {
          setSalonIdState(list[0].id);
          write(SALON_KEY, list[0].id);
        }
      });
      return;
    }
    supabase.from("salons").select("id, name").order("name").then(({ data }) => {
      const list = data ?? [];
      setSalons(list);
      if (list.length === 1 && salonId === "all") {
        setSalonIdState(list[0].id);
        write(SALON_KEY, list[0].id);
      } else if (salonId !== "all" && !list.find((s) => s.id === salonId)) {
        setSalonIdState("all");
        write(SALON_KEY, null);
      }
    });
  }, [isSuperAdmin, isMaster, ownSalonId]);

  useEffect(() => {
    if (isMaster && !isSuperAdmin) {
      if (ownBranchId) {
        setBranchIdState(ownBranchId);
        write(BRANCH_KEY, ownBranchId);
      } else if (branchId !== "all") {
        setBranchIdState("all");
        write(BRANCH_KEY, null);
      }
    }

    if (salonId === "all") { setBranches([]); return; }
    supabase.from("branches").select("id, name, address").eq("salon_id", salonId).eq("is_active", true).order("sort_order")
      .then(({ data }) => {
        const list = (data ?? []) as AdminBranch[];
        setBranches(list);
        // Master: lock branch to own.
        if (isMaster && !isSuperAdmin && ownBranchId) {
          setBranchIdState(ownBranchId);
          write(BRANCH_KEY, ownBranchId);
          return;
        }
        if (isMaster && !isSuperAdmin && !ownBranchId) {
          setBranchIdState("all");
          write(BRANCH_KEY, null);
          return;
        }
        if (branchId !== "all" && !list.find((b) => b.id === branchId)) {
          setBranchIdState("all");
          write(BRANCH_KEY, null);
        }
      });
  }, [salonId, isMaster, isSuperAdmin, ownBranchId, branchId]);

  function setSalonId(id: string) {
    if (!isSuperAdmin && ownSalonId && id !== ownSalonId) return;
    setSalonIdState(id);
    write(SALON_KEY, id === "all" ? null : id);
    setBranchIdState("all");
    write(BRANCH_KEY, null);
  }
  function setBranchId(id: string) {
    // Master can't change branch
    if (isMaster && !isSuperAdmin && ownBranchId && id !== ownBranchId) return;
    setBranchIdState(id);
    write(BRANCH_KEY, id === "all" ? null : id);
  }

  const currentSalon = salons.find((s) => s.id === salonId) ?? null;
  const currentBranch = branches.find((b) => b.id === branchId) ?? null;

  return {
    salons, branches, salonId, branchId,
    setSalonId, setBranchId,
    currentSalon, currentBranch,
    isSuperAdmin, isMaster,
  };
}
