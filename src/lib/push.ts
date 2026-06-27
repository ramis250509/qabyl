import { supabase } from "@/integrations/supabase/client";

const BUILD_VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
let runtimeVapidPublicKey: string | null = null;

type PushDebug = (message: string, details?: unknown) => void;

type EnsurePushOptions = {
  salonId?: string | null;
  branchId?: string | null;
  forceResubscribe?: boolean;
  skipPermissionRequest?: boolean;
  debug?: PushDebug;
};

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function debugLog(debug: PushDebug | undefined, message: string, details?: unknown) {
  try { debug?.(message, details); } catch {}
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getVapidPublicKey(debug?: PushDebug): Promise<string | null> {
  if (runtimeVapidPublicKey) return runtimeVapidPublicKey;
  try {
    debugLog(debug, "vapid: loading runtime public key from send-push");
    const { data, error } = await supabase.functions.invoke("send-push", { method: "GET" });
    if (error) throw error;
    const key = typeof data?.vapidPublicKey === "string" ? data.vapidPublicKey.trim() : "";
    if (key) {
      runtimeVapidPublicKey = key;
      debugLog(debug, "vapid: runtime key loaded", { length: key.length, prefix: key.slice(0, 8) });
      return key;
    }
  } catch (error) {
    debugLog(debug, "vapid: runtime key load failed, using build key", stringifyError(error));
  }
  return BUILD_VAPID_PUBLIC_KEY ?? null;
}

export function isPushSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function isStandalonePWA(): boolean {
  if (typeof window === "undefined") return false;
  const mql = window.matchMedia?.("(display-mode: standalone)").matches;
  // iOS Safari uses navigator.standalone
  const iosStandalone = (window.navigator as any).standalone === true;
  return Boolean(mql || iosStandalone);
}

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

async function getOrRegisterSW(debug?: PushDebug): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/sw.js");
  if (existing) {
    debugLog(debug, "serviceWorker: existing registration", {
      scope: existing.scope,
      active: existing.active?.state ?? null,
      waiting: existing.waiting?.state ?? null,
      installing: existing.installing?.state ?? null,
    });
    // Best-effort: pull the latest sw.js so a stale worker doesn't keep
    // serving and silently drop pushes after a deploy.
    try {
      await existing.update();
      debugLog(debug, "serviceWorker: update checked");
    } catch (error) {
      debugLog(debug, "serviceWorker: update failed", stringifyError(error));
    }
    return existing;
  }
  debugLog(debug, "serviceWorker: registering /sw.js");
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  debugLog(debug, "serviceWorker: registered", {
    scope: registration.scope,
    active: registration.active?.state ?? null,
    waiting: registration.waiting?.state ?? null,
    installing: registration.installing?.state ?? null,
  });
  return registration;
}

async function waitForReady(debug?: PushDebug): Promise<ServiceWorkerRegistration> {
  debugLog(debug, "serviceWorker: waiting for ready");
  const timeout = new Promise<never>((_, reject) => {
    window.setTimeout(() => reject(new Error("navigator.serviceWorker.ready timeout after 8s")), 8000);
  });
  const registration = await Promise.race([navigator.serviceWorker.ready, timeout]);
  debugLog(debug, "serviceWorker: ready", {
    scope: registration.scope,
    active: registration.active?.state ?? null,
  });
  return registration;
}

export async function ensurePushSubscription(opts?: EnsurePushOptions) {
  const debug = opts?.debug;
  debugLog(debug, "push: start", {
    supported: isPushSupported(),
    permission: typeof Notification !== "undefined" ? Notification.permission : "missing",
    forceResubscribe: !!opts?.forceResubscribe,
    standalone: isStandalonePWA(),
    ios: isIos(),
    buildVapidLength: BUILD_VAPID_PUBLIC_KEY?.length ?? 0,
  });

  if (!isPushSupported()) return { ok: false, reason: "unsupported" as const };
  const vapidPublicKey = await getVapidPublicKey(debug);
  if (!vapidPublicKey) return { ok: false, reason: "no-vapid" as const };
  // iOS only allows Web Push when installed to Home Screen.
  if (isIos() && !isStandalonePWA()) return { ok: false, reason: "ios-needs-install" as const };

  let permission = Notification.permission;
  if (permission === "default" && !opts?.skipPermissionRequest) {
    debugLog(debug, "permission: requesting");
    try {
      permission = await Notification.requestPermission();
      debugLog(debug, "permission: result", permission);
    } catch (error) {
      debugLog(debug, "permission: request failed", stringifyError(error));
      return { ok: false as const, reason: "permission-error" as const, error: stringifyError(error) };
    }
  }
  if (permission !== "granted") return { ok: false, reason: "denied" as const, permission };

  try {
    await getOrRegisterSW(debug);
  } catch (error) {
    debugLog(debug, "serviceWorker: register failed", stringifyError(error));
    return { ok: false as const, reason: "sw-error" as const, error: stringifyError(error) };
  }
  // Always use the active (ready) registration for pushManager so the
  // subscription is bound to the currently-controlling worker.
  let reg: ServiceWorkerRegistration;
  try {
    reg = await waitForReady(debug);
  } catch (error) {
    debugLog(debug, "serviceWorker: ready failed", stringifyError(error));
    return { ok: false as const, reason: "sw-error" as const, error: stringifyError(error) };
  }

  let sub = await reg.pushManager.getSubscription();
  debugLog(debug, "pushManager: existing subscription", sub ? { endpoint: sub.endpoint.slice(0, 80) } : null);
  if (sub) {
    // If the existing subscription was created with a different VAPID key,
    // recreate it so push delivery doesn't fail with BadVapidPublicKey.
    const cur = sub.options?.applicationServerKey as ArrayBuffer | null;
    const want = urlBase64ToUint8Array(vapidPublicKey);
    const same = cur && new Uint8Array(cur).every((b, i) => b === want[i]) &&
      new Uint8Array(cur).length === want.length;
    if (opts?.forceResubscribe || !same) {
      debugLog(debug, opts?.forceResubscribe ? "pushManager: force resubscribe" : "pushManager: VAPID mismatch, resubscribing", {
        endpoint: sub.endpoint.slice(0, 80),
        currentKeyBytes: cur ? new Uint8Array(cur).length : 0,
        wantedKeyBytes: want.length,
      });
      try {
        await (supabase as any).from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        debugLog(debug, "database: old endpoint delete attempted");
      } catch (error) {
        debugLog(debug, "database: old endpoint delete failed", stringifyError(error));
      }
      try {
        await sub.unsubscribe();
        debugLog(debug, "pushManager: old subscription unsubscribed");
      } catch (error) {
        debugLog(debug, "pushManager: unsubscribe failed", stringifyError(error));
      }
      sub = null;
    } else {
      debugLog(debug, "pushManager: existing VAPID key matches");
    }
  }
  if (!sub) {
    debugLog(debug, "pushManager: subscribing");
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as unknown as BufferSource,
      });
      debugLog(debug, "pushManager: subscribed", { endpoint: sub.endpoint.slice(0, 80) });
    } catch (error) {
      debugLog(debug, "pushManager: subscribe failed", stringifyError(error));
      return { ok: false as const, reason: "subscribe-error" as const, error: stringifyError(error) };
    }
  }

  const json = sub.toJSON();
  debugLog(debug, "auth: loading user");
  const { data: userRes } = await supabase.auth.getUser();
  const userId = userRes.user?.id ?? null;
  if (!userId) {
    // RLS требует user_id = auth.uid(); без сессии запись не сохранится.
    return { ok: false as const, reason: "not-authenticated" as const };
  }

  // Upsert by endpoint (unique).
  debugLog(debug, "database: upserting push_subscriptions", {
    salonId: opts?.salonId ?? null,
    branchId: opts?.branchId ?? null,
    endpoint: json.endpoint?.slice(0, 80),
  });
  const { error: upsertErr } = await (supabase as any).from("push_subscriptions").upsert(
    {
      user_id: userId,
      salon_id: opts?.salonId ?? null,
      branch_id: opts?.branchId ?? null,
      endpoint: json.endpoint!,
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 300) : null,
    },
    { onConflict: "endpoint" },
  );
  if (upsertErr) {
    console.error("push_subscriptions upsert failed", upsertErr);
    debugLog(debug, "database: upsert failed", upsertErr.message);
    return { ok: false as const, reason: "db-error" as const, error: upsertErr.message };
  }

  debugLog(debug, "database: upsert ok");
  return { ok: true as const, subscription: sub };
}

export async function disablePushSubscription() {
  if (!isPushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    try {
      await (supabase as any).from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    } catch {}
    try { await sub.unsubscribe(); } catch {}
  }
}
