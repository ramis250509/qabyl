// Сессия пользователя в браузере: кто вошёл, какие у него роли и — главное — что делать, когда
// сессия пропала не по его воле.
//
// ЧТО ЗДЕСЬ СЛУЧИЛОСЬ. Владелица салона «с того ни с сего» оказывалась на экране входа: чаще
// всего после того, как телефон сутки держал PWA замороженным, реже — после выхода из кабинета
// на другом устройстве. Оба раза виноват не роутер: к моменту редиректа сессии в самом деле уже
// не было. Её удалял supabase-js, и у него на это ровно три причины (GoTrueClient.js,
// _removeSession): битая запись в localStorage, невалидный ответ на обновление токена и
// глобальный выход. Прежний код честно перепроверял getSession() через 500 мс — но к этому
// моменту refresh-токен уже стёрт из хранилища, перепроверять было нечего, и «перепроверка»
// всегда подтверждала выход.
//
// ТРИ ИСПРАВЛЕНИЯ, каждое закрывает свою причину:
//
//   1. ВЫХОД ТЕПЕРЬ ЛОКАЛЬНЫЙ. supabase.auth.signOut() по умолчанию имеет scope "global": он
//      отзывает refresh-токены пользователя НА ВСЕХ устройствах. Владелица выходит из кабинета
//      на ноутбуке — телефон с установленным PWA получает мёртвый токен и при следующем
//      пробуждении улетает на экран входа. Именно так это и выглядит: «ничего не делала, а меня
//      выкинуло». Выход из этого устройства больше не касается остальных.
//
//   2. ЗЕРКАЛО REFRESH-ТОКЕНА. Мы храним собственную копию refresh-токена рядом с сессией.
//      supabase-js стирает свою при первой же неудаче обновления, в том числе когда неудача
//      сетевая и временная. Копия переживает эту чистку, и по ней сессию можно поднять обратно.
//      Копия не даёт новых прав: это тот же токен, что и так лежал в localStorage этого
//      браузера. Он исчезает при выходе и при отказе сервера.
//
//   3. ВЫХОД ТОЛЬКО ПО ОТВЕТУ СЕРВЕРА. Пропажа сессии сама по себе больше не считается выходом.
//      Сначала мы пробуем восстановиться по зеркалу — с ожиданием сети и несколькими попытками.
//      На экран входа человек попадает, лишь когда сервер прямо сказал «этот токен
//      недействителен» (400/401/403). Сетевой сбой, 5xx и заморозка PWA в офлайне больше не
//      выкидывают никого: кабинет ждёт связи, показывая загрузку.
//
// И ЕЩЁ ОДНО: стор стал общим. useAuth() вызывается в четырнадцати компонентах, и раньше каждый
// заводил свою подписку, свои три getSession() при старте и свою копию ролей. Теперь подписка и
// восстановление одни на вкладку — иначе четырнадцать восстановлений гонятся друг с другом за
// один и тот же токен и сами создают ту ошибку «refresh token already used», от которой лечимся.
import { useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Session, User } from "@supabase/supabase-js";
// Решение «это настоящий выход или временный сбой» живёт отдельно и покрыто тестами:
// от него зависит единственное необратимое действие кабинета — редирект на экран входа.
import { isTokenRejected } from "@/lib/auth-session-policy";

export type AuthState = {
  user: User | null;
  loading: boolean;
  rolesLoading: boolean;
  isSuperAdmin: boolean;
  isSalonAdmin: boolean;
  isManager: boolean;
  isMaster: boolean;
  salonId: string | null;
  branchId: string | null;
  /**
   * Сессия пропала, и мы прямо сейчас пробуем её поднять. Не «нет пользователя» и не «есть
   * пользователь» — третье состояние, которого раньше не было и из-за отсутствия которого
   * любая заминка сети читалась как выход. Экраны показывают в нём загрузку и НЕ редиректят.
   */
  recovering: boolean;
};

const INITIAL: AuthState = {
  user: null,
  loading: true,
  rolesLoading: true,
  isSuperAdmin: false,
  isSalonAdmin: false,
  isManager: false,
  isMaster: false,
  salonId: null,
  branchId: null,
  recovering: false,
};

// ---------------------------------------------------------------------------
// Хранилище
// ---------------------------------------------------------------------------

/** Зеркало refresh-токена. См. пункт 2 в шапке. */
const MIRROR_KEY = "qabyl.auth.mirror";
/** Кольцо последних событий сессии. Уезжает на сервер при следующем удачном входе. */
const DIAG_KEY = "qabyl.auth.diag";
const DIAG_MAX = 24;

type Mirror = { rt: string; uid: string; at: number };

function readMirror(): Mirror | null {
  try {
    const raw = window.localStorage.getItem(MIRROR_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as Mirror;
    return m && typeof m.rt === "string" && m.rt ? m : null;
  } catch {
    return null;
  }
}

function writeMirror(session: Session) {
  try {
    if (!session.refresh_token) return;
    const next: Mirror = { rt: session.refresh_token, uid: session.user.id, at: Date.now() };
    window.localStorage.setItem(MIRROR_KEY, JSON.stringify(next));
  } catch {
    // Приватный режим, переполненное хранилище — зеркало необязательно, без него просто
    // теряется страховка. Ронять из-за этого вход нельзя.
  }
}

function clearMirror() {
  try {
    window.localStorage.removeItem(MIRROR_KEY);
  } catch {
    /* см. writeMirror */
  }
}

export type AuthDiagEntry = { at: number; kind: string; detail?: string };

/**
 * Записать, что случилось с сессией.
 *
 * ЗАЧЕМ. Вылет происходит на чужом телефоне, ночью, без консоли и без возможности спросить.
 * Пока причина не записана, каждая такая жалоба разбирается гаданием. Запись локальная и
 * уезжает на сервер при следующем удачном входе — то есть ровно тогда, когда человек вернулся
 * в кабинет после вылета. Токенов и паролей здесь нет: только имя события и код ошибки.
 */
function note(kind: string, detail?: string) {
  try {
    const raw = window.localStorage.getItem(DIAG_KEY);
    const list: AuthDiagEntry[] = raw ? JSON.parse(raw) : [];
    list.push({ at: Date.now(), kind, detail: detail?.slice(0, 200) });
    window.localStorage.setItem(DIAG_KEY, JSON.stringify(list.slice(-DIAG_MAX)));
  } catch {
    /* диагностика не имеет права мешать работе */
  }
}

export function readAuthDiagnostics(): AuthDiagEntry[] {
  try {
    const raw = window.localStorage.getItem(DIAG_KEY);
    return raw ? (JSON.parse(raw) as AuthDiagEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearAuthDiagnostics() {
  try {
    window.localStorage.removeItem(DIAG_KEY);
  } catch {
    /* см. note */
  }
}

// ---------------------------------------------------------------------------
// Стор
// ---------------------------------------------------------------------------

let state: AuthState = INITIAL;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<AuthState>) {
  let changed = false;
  for (const k of Object.keys(patch) as (keyof AuthState)[]) {
    if (state[k] !== patch[k]) {
      changed = true;
      break;
    }
  }
  // Ре-рендер четырнадцати компонентов стоит дорого, а обновление токена приносит один и тот же
  // объект пользователя по несколько раз в час. Без этой проверки кабинет «моргает» на ровном
  // месте — именно так выглядела прежняя версия при возврате на вкладку.
  if (!changed) return;
  state = { ...state, ...patch };
  emit();
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Выход
// ---------------------------------------------------------------------------

let intentionalSignOut = false;

function markIntentional(ms = 5000) {
  intentionalSignOut = true;
  setTimeout(() => {
    intentionalSignOut = false;
  }, ms);
}

/**
 * Выйти из кабинета на ЭТОМ устройстве.
 *
 * scope: "local" — не опечатка и не упрощение. Глобальный выход отзывает refresh-токены на всех
 * устройствах разом, и человек, вышедший на ноутбуке, обнаруживает себя выкинутым из приложения
 * на телефоне. Ровно на это и жаловались. «Выйти везде» — это отдельное осознанное действие, а
 * не побочный эффект кнопки «Выйти».
 */
export async function signOutFromApp() {
  markIntentional();
  // Чистим зеркало ДО выхода: иначе гонка между SIGNED_OUT и удалением копии успеет запустить
  // восстановление и вернёт человека обратно в кабинет, из которого он только что вышел.
  // Удаление ключа видно другим вкладкам через событие storage — они тоже поймут, что выход
  // намеренный, и не станут воскрешать сессию.
  clearMirror();
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch (e) {
    note("signout-error", (e as Error)?.message);
  }
}

// ---------------------------------------------------------------------------
// Восстановление
// ---------------------------------------------------------------------------

function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** Ждём сеть, но не вечно: браузер иногда врёт про offline, а мы всё равно попробуем. */
async function waitForNetwork(maxMs: number) {
  if (online()) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener("online", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, maxMs);
    window.addEventListener("online", done);
  });
}

let recoveryInFlight: Promise<Session | null> | null = null;

/**
 * Поднять сессию по зеркалу.
 *
 * Возвращает сессию, если удалось; null, если сервер отказал (настоящий выход) ИЛИ если связи
 * так и не случилось. Эти два исхода различает вызывающий по тому, осталось ли зеркало: при
 * отказе сервера оно стёрто, при отсутствии связи — нет.
 */
function recoverSession(reason: string): Promise<Session | null> {
  // Одна попытка на вкладку. Параллельные восстановления гонятся за один и тот же refresh-токен
  // и сами вызывают «already used» — ту самую ошибку, из-за которой supabase-js стирает сессию.
  if (recoveryInFlight) return recoveryInFlight;
  recoveryInFlight = (async () => {
    const mirror = readMirror();
    if (!mirror) {
      note("recover-skipped", reason + ": нет зеркала");
      return null;
    }
    setState({ recovering: true });
    note("recover-start", reason);
    const delays = [0, 800, 2500, 6000];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) await wait(delays[attempt]);
      await waitForNetwork(15_000);

      // Сначала — не пропала ли тревога сама. Другая вкладка или сам supabase-js могли уже
      // обновить токен; тогда в хранилище лежит живая сессия, и трогать refresh-токен нельзя.
      const { data: existing } = await supabase.auth.getSession();
      if (existing.session) {
        note("recover-ok", "сессия нашлась сама");
        return existing.session;
      }

      const { data, error } = await supabase.auth.refreshSession({ refresh_token: mirror.rt });
      if (data?.session) {
        note("recover-ok", "попытка " + (attempt + 1));
        return data.session;
      }
      if (isTokenRejected(error)) {
        const code = (error as { code?: string } | null)?.code ?? error?.name ?? "?";
        note("recover-rejected", code + ": " + (error?.message ?? ""));
        clearMirror();
        return null;
      }
      note("recover-retry", "попытка " + (attempt + 1) + ": " + (error?.message ?? "нет сессии"));
    }
    // Связи так и не случилось. Зеркало НЕ трогаем — попробуем снова, когда появится сеть.
    note("recover-gave-up", reason);
    return null;
  })().finally(() => {
    recoveryInFlight = null;
  });
  return recoveryInFlight;
}

// ---------------------------------------------------------------------------
// Роли
// ---------------------------------------------------------------------------

let rolesUid: string | null = null;

async function loadRoles(uid: string) {
  setState({ rolesLoading: true });
  const first = await supabase
    .from("user_roles")
    .select("role, salon_id, branch_id")
    .eq("user_id", uid);
  // Одна повторная попытка: на холодном старте PWA первый запрос к базе иногда уходит раньше,
  // чем клиент получил свежий access-токен, и возвращает ошибку прав на пустом месте. Без
  // ретрая владелец получал кабинет без единой роли — то есть мастер создания второго салона.
  let data = first.data;
  if (first.error) {
    await wait(350);
    const retry = await supabase
      .from("user_roles")
      .select("role, salon_id, branch_id")
      .eq("user_id", uid);
    data = retry.data;
  }
  // Пока грузились роли, человек мог выйти или смениться. Положить роли чужого пользователя —
  // худший из возможных исходов: кабинет показал бы чужой салон.
  if (rolesUid !== uid) return;
  const roles = (data ?? []) as {
    role: string;
    salon_id: string | null;
    branch_id: string | null;
  }[];
  const salonRole = roles.find((r) => r.role === "salon_admin");
  const managerRole = roles.find((r) => r.role === "manager");
  const masterRole = roles.find((r) => r.role === "master");
  setState({
    isSuperAdmin: roles.some((r) => r.role === "super_admin"),
    isSalonAdmin: !!salonRole,
    isManager: !!managerRole,
    isMaster: !!masterRole,
    salonId: salonRole?.salon_id ?? managerRole?.salon_id ?? masterRole?.salon_id ?? null,
    branchId: masterRole?.branch_id ?? null,
    rolesLoading: false,
  });
}

function clearRoles() {
  setState({
    isSuperAdmin: false,
    isSalonAdmin: false,
    isManager: false,
    isMaster: false,
    salonId: null,
    branchId: null,
    rolesLoading: false,
  });
}

function applyUser(u: User | null) {
  const uid = u?.id ?? null;
  if (uid !== (state.user?.id ?? null)) setState({ user: u });
  if (!uid) {
    rolesUid = null;
    clearRoles();
    return;
  }
  if (rolesUid !== uid) {
    rolesUid = uid;
    void loadRoles(uid);
  }
}

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------

async function readSessionWithRetry(): Promise<Session | null> {
  // Холодный старт PWA: localStorage иногда отдаёт сессию не с первой попытки.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session || attempt === 2) return session ?? null;
    await wait(attempt === 0 ? 150 : 350);
  }
  return null;
}

/**
 * Сессия пропала не по воле человека. Единственное место, где принимается решение «это выход».
 */
async function handleSessionLoss(reason: string) {
  const restored = await readSessionWithRetry();
  if (restored) {
    applyUser(restored.user);
    setState({ recovering: false, loading: false });
    return;
  }
  if (!readMirror()) {
    // Зеркала нет — восстанавливать нечем. Это либо намеренный выход, либо человек, который
    // никогда и не входил.
    applyUser(null);
    setState({ recovering: false, loading: false });
    return;
  }
  const session = await recoverSession(reason);
  if (session) {
    applyUser(session.user);
    setState({ recovering: false, loading: false });
    return;
  }
  if (readMirror()) {
    // Сервер не отказывал — просто не дозвонились. Держим кабинет в ожидании: попробуем ещё раз
    // при возврате на вкладку или при появлении сети (слушатели ниже).
    setState({ recovering: true, loading: false });
    return;
  }
  note("signed-out", reason);
  applyUser(null);
  setState({ recovering: false, loading: false });
}

let started = false;

function start() {
  if (started || typeof window === "undefined") return;
  started = true;

  supabase.auth.onAuthStateChange((event, session) => {
    if (session) writeMirror(session);

    // Обновление токена не меняет ни человека, ни роли.
    if (event === "TOKEN_REFRESHED") {
      setState({ recovering: false });
      return;
    }

    if (event === "SIGNED_OUT") {
      if (intentionalSignOut) {
        clearMirror();
        applyUser(null);
        setState({ recovering: false, loading: false });
        return;
      }
      note("signed-out-event", "supabase удалил сессию");
      void handleSessionLoss("SIGNED_OUT");
      return;
    }

    if (session?.user) {
      applyUser(session.user);
      setState({ recovering: false, loading: false });
      return;
    }

    // Событие без сессии и не SIGNED_OUT (INITIAL_SESSION на холодном старте). Пока первичная
    // проверка не закончилась, такое событие ничего не значит — им и занимается ветка ниже.
    if (!state.loading) void handleSessionLoss(event);
  });

  readSessionWithRetry()
    .then(async (session) => {
      if (session) {
        writeMirror(session);
        applyUser(session.user);
        setState({ loading: false });
        void flushDiagnostics();
        return;
      }
      if (readMirror()) {
        // Сессии нет, а зеркало есть: её удалили, пока вкладка была закрыта или заморожена.
        // Это и есть тот самый вылет — здесь он лечится молча, до первого редиректа.
        await handleSessionLoss("cold-start");
        void flushDiagnostics();
        return;
      }
      applyUser(null);
      setState({ loading: false });
    })
    .catch((e) => {
      note("initial-session-error", (e as Error)?.message);
      setState({ loading: false, rolesLoading: false });
    });

  // Вернулась сеть или человек вернулся на вкладку — повод попробовать ещё раз.
  const retry = () => {
    if (state.recovering && readMirror()) void handleSessionLoss("retry");
  };
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") retry();
  });

  // Выход в соседней вкладке. supabase-js разошлёт туда SIGNED_OUT, и без этого слушателя
  // соседняя вкладка сочла бы его случайным и воскресила сессию по своему зеркалу.
  window.addEventListener("storage", (e) => {
    if (e.key === MIRROR_KEY && e.newValue === null) markIntentional();
  });
}

/**
 * Отправить накопленную диагностику вылетов.
 *
 * Отправляем только из-под живой сессии и только то, что уже случилось: сервер-функция требует
 * авторизации, и заводить ради этого открытый эндпоинт значило бы подарить всем желающим запись
 * в журнал ошибок. Момент выбран не случайно: человек, которого вчера выкинуло, возвращается в
 * кабинет сегодня — и запись приезжает вместе с ним.
 */
async function flushDiagnostics() {
  const entries = readAuthDiagnostics();
  if (entries.length === 0) return;
  // Ничего интересного не произошло — не шумим.
  if (!entries.some((e) => e.kind.startsWith("recover") || e.kind.startsWith("signed-out"))) {
    clearAuthDiagnostics();
    return;
  }
  try {
    const { reportAuthDiagnostics } = await import("@/lib/auth-diagnostics.functions");
    await reportAuthDiagnostics({
      data: {
        entries: entries.slice(-DIAG_MAX),
        userAgent: navigator.userAgent.slice(0, 300),
        standalone: Boolean(
          window.matchMedia?.("(display-mode: standalone)").matches ||
          (navigator as unknown as { standalone?: boolean }).standalone === true,
        ),
      },
    });
    clearAuthDiagnostics();
  } catch {
    // Не дошло — оставляем запись до следующего захода.
  }
}

// ---------------------------------------------------------------------------
// Хук
// ---------------------------------------------------------------------------

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;
// На сервере состояние всегда исходное и всегда один и тот же объект: useSyncExternalStore
// сравнивает снимки по ссылке и зациклится, если возвращать новый.
const getServerSnapshot = () => INITIAL;

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
