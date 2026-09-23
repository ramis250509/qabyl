// The simulated world a conversation runs in: one in-memory database with salons in it, a fake
// WhatsApp transport that records what the assistant sent, and a client session that delivers
// messages exactly the way Meta does — as signed webhook payloads into the REAL pipeline
// (processWaCloudPayload → ingest → lock → drain → runWaAgentV4 → tools → reply).
//
// Nothing in src/ is replaced except the Supabase client (→ FakeSupabase) and the transport
// (→ FakeTransport). The assistant, its tools, its guards and the webhook logic are production code.

import { FakeSupabase, localDateOf, localTimeOf, localToUtcMs, nowIso } from "./fake-db";

export type Row = Record<string, any>;

// ─── transport ────────────────────────────────────────────────────────────────────────────────

export type OutMessage = {
  to: string;
  text: string;
  at: string;
  kind: "text" | "image";
  ok: boolean;
};

export class FakeTransport {
  readonly kind = "cloud" as const;
  readonly ready = true;
  readonly missing = "";
  outbox: OutMessage[] = [];
  /** Fail the next N sends (Meta refusing delivery, e.g. 131047 outside the 24h window). */
  failSends = new Map<string, number>();

  private fail(to: string): boolean {
    const n = this.failSends.get(to) ?? 0;
    if (n <= 0) return false;
    this.failSends.set(to, n - 1);
    return true;
  }
  async sendText(to: string, text: string) {
    const ok = !this.fail(to);
    this.outbox.push({ to, text, at: nowIso(), kind: "text", ok });
    return ok
      ? { ok: true, messageId: `wamid.out.${crypto.randomUUID()}` }
      : { ok: false, error: "code=131047 simulated delivery failure" };
  }
  async sendImage(to: string, url: string, caption?: string | null) {
    this.outbox.push({
      to,
      text: `[image ${url}] ${caption ?? ""}`,
      at: nowIso(),
      kind: "image",
      ok: true,
    });
    return { ok: true, messageId: `wamid.out.${crypto.randomUUID()}` };
  }
  async markReadAndTyping() {}
  async fetchMedia() {
    return null;
  }
}

// ─── salon fixtures ───────────────────────────────────────────────────────────────────────────

export type ServiceSpec = {
  name: string;
  price: number;
  price_max?: number;
  price_type?: "fixed" | "range";
  duration_min: number;
  duration_max_min?: number;
  buffer_after_min?: number;
  category?: string;
};
export type ScheduleSpec = { weekdays: number[]; start: string; end: string };
export type MasterSpec = {
  name: string;
  services: string[];
  branch?: string | null;
  schedule?: ScheduleSpec;
  specialization?: string;
};
export type BranchSpec = { name: string; address: string };
export type SalonSpec = {
  name: string;
  timezone?: string;
  address?: string;
  branches: BranchSpec[];
  services: ServiceSpec[];
  masters: MasterSpec[];
  assistant?: Row;
  workingHoursText?: Record<string, string>;
};

export type SalonHandle = {
  salonId: string;
  tz: string;
  salon: Row;
  assistant: Row;
  secrets: Row;
  spec: SalonSpec;
  serviceId: (name: string) => string;
  masterId: (name: string) => string;
  branchId: (name: string) => string;
  serviceName: (id: string) => string;
  masterName: (id: string) => string;
  branchName: (id: string | null) => string | null;
  /** YYYY-MM-DD in the salon's timezone, `days` from today. */
  localDate: (days: number) => string;
};

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];

export const DEFAULT_SERVICES: ServiceSpec[] = [
  { name: "Женская стрижка", price: 1200, duration_min: 60, category: "Волосы" },
  { name: "Мужская стрижка", price: 700, duration_min: 45, category: "Волосы" },
  {
    name: "Окрашивание",
    price: 3000,
    price_max: 6000,
    price_type: "range",
    duration_min: 150,
    buffer_after_min: 15,
    category: "Волосы",
  },
  { name: "Маникюр", price: 1000, duration_min: 60, category: "Ногти" },
  { name: "Педикюр", price: 1500, duration_min: 75, category: "Ногти" },
];

export const DEFAULT_SALON: SalonSpec = {
  name: "Studio Nova",
  timezone: "Asia/Bishkek",
  address: "Бишкек, ул. Токтогула 101",
  branches: [{ name: "Studio Nova", address: "Бишкек, ул. Токтогула 101" }],
  services: DEFAULT_SERVICES,
  masters: [
    {
      name: "Айгуль",
      services: ["Женская стрижка", "Окрашивание"],
      schedule: { weekdays: ALL_WEEK, start: "10:00", end: "20:00" },
      specialization: "сложное окрашивание",
    },
    {
      name: "Айжан",
      services: ["Женская стрижка", "Маникюр", "Педикюр"],
      schedule: { weekdays: ALL_WEEK, start: "09:00", end: "18:00" },
    },
    {
      name: "Бекзат",
      services: ["Мужская стрижка"],
      schedule: { weekdays: ALL_WEEK, start: "10:00", end: "21:00" },
    },
  ],
  workingHoursText: {
    mon: "09:00–21:00",
    tue: "09:00–21:00",
    wed: "09:00–21:00",
    thu: "09:00–21:00",
    fri: "09:00–21:00",
    sat: "09:00–21:00",
    sun: "09:00–21:00",
  },
};

export const MULTI_BRANCH_SALON: SalonSpec = {
  name: "Beauty Lab",
  timezone: "Asia/Bishkek",
  address: "Бишкек",
  branches: [
    { name: "Центр", address: "Бишкек, ул. Киевская 77" },
    { name: "Джал", address: "Бишкек, мкр. Джал, 15/1" },
  ],
  services: DEFAULT_SERVICES,
  masters: [
    {
      name: "Айгуль",
      branch: "Центр",
      services: ["Женская стрижка", "Окрашивание"],
      schedule: { weekdays: ALL_WEEK, start: "10:00", end: "20:00" },
    },
    {
      name: "Нурай",
      branch: "Центр",
      services: ["Маникюр", "Педикюр"],
      schedule: { weekdays: ALL_WEEK, start: "10:00", end: "19:00" },
    },
    {
      name: "Динара",
      branch: "Джал",
      services: ["Женская стрижка", "Маникюр"],
      schedule: { weekdays: ALL_WEEK, start: "09:00", end: "18:00" },
    },
    {
      name: "Бекзат",
      branch: "Джал",
      services: ["Мужская стрижка"],
      schedule: { weekdays: ALL_WEEK, start: "10:00", end: "21:00" },
    },
  ],
  workingHoursText: DEFAULT_SALON.workingHoursText,
};

/** One master, one service, and (after `fillDayExcept`) exactly one free slot — for race tests. */
export const SOLO_SALON: SalonSpec = {
  name: "Brow Point",
  timezone: "Asia/Bishkek",
  address: "Бишкек, ул. Ахунбаева 12",
  branches: [{ name: "Brow Point", address: "Бишкек, ул. Ахунбаева 12" }],
  services: [{ name: "Коррекция бровей", price: 800, duration_min: 60 }],
  masters: [
    {
      name: "Айгуль",
      services: ["Коррекция бровей"],
      schedule: { weekdays: ALL_WEEK, start: "10:00", end: "19:00" },
    },
  ],
};

let salonSeq = 0;

export class SimWorld {
  db = new FakeSupabase();
  transport = new FakeTransport();
  salons = new Map<string, SalonHandle>();

  createSalon(spec: SalonSpec, overrides: { assistant?: Row } = {}): SalonHandle {
    const db = this.db;
    const tz = spec.timezone ?? "Asia/Bishkek";
    salonSeq++;
    const salon = db.seed("salons", {
      name: spec.name,
      slug: `sim-${salonSeq}-${Math.random().toString(36).slice(2, 7)}`,
      timezone: tz,
      address: spec.address ?? null,
      working_hours: spec.workingHoursText ?? {},
      custom_domain: null,
      is_active: true,
      ai_assistant_enabled: true,
      whatsapp_ai_enabled: true,
      whatsapp_enabled: true,
      instagram_enabled: false,
      wa_provider: "cloud",
    });
    const assistant = db.seed("salon_ai_assistant", {
      salon_id: salon.id,
      enabled: true,
      engine: "v4",
      industry: "beauty",
      languages: ["ru", "ky", "en"],
      start_language: "ru",
      greeting: null,
      manage_cutoff_hours: 0,
      min_lead_minutes: 0,
      sales_style: "light",
      sales_mode: false,
      booking_link_mode: "auto",
      rich_formatting: false,
      ai_category_order: [],
      ai_hidden_categories: [],
      knowledge_answers: {},
      ...(spec.assistant ?? {}),
      ...(overrides.assistant ?? {}),
    });
    const secrets = db.seed("salon_secrets", {
      salon_id: salon.id,
      whatsapp_cloud_phone_number_id: `pnid-${salon.id.slice(0, 8)}`,
      whatsapp_cloud_token: "sim-token",
      owner_notify_phone: "996700000001",
    });

    const branchIds = new Map<string, string>();
    spec.branches.forEach((b, i) => {
      const row = db.seed("branches", {
        salon_id: salon.id,
        name: b.name,
        address: b.address,
        sort_order: i,
      });
      branchIds.set(b.name, row.id);
    });
    const serviceIds = new Map<string, string>();
    spec.services.forEach((s, i) => {
      const row = db.seed("services", {
        salon_id: salon.id,
        name: s.name,
        price: s.price,
        price_max: s.price_max ?? null,
        price_type: s.price_type ?? "fixed",
        duration_min: s.duration_min,
        duration_max_min: s.duration_max_min ?? null,
        buffer_after_min: s.buffer_after_min ?? 0,
        category: s.category ?? null,
        sort_order: i,
      });
      serviceIds.set(s.name, row.id);
    });
    const masterIds = new Map<string, string>();
    spec.masters.forEach((m, i) => {
      const row = db.seed("masters", {
        salon_id: salon.id,
        name: m.name,
        branch_id: m.branch ? branchIds.get(m.branch)! : null,
        sort_order: i,
        specialization: m.specialization ?? null,
      });
      masterIds.set(m.name, row.id);
      for (const s of m.services)
        db.seed("master_services", { master_id: row.id, service_id: serviceIds.get(s)! });
      const sch = m.schedule ?? { weekdays: ALL_WEEK, start: "10:00", end: "19:00" };
      for (const wd of sch.weekdays) {
        db.seed("master_schedules", {
          master_id: row.id,
          weekday: wd,
          start_time: `${sch.start}:00`,
          end_time: `${sch.end}:00`,
        });
      }
    });

    const inv = (m: Map<string, string>) => new Map([...m].map(([k, v]) => [v, k]));
    const serviceById = inv(serviceIds);
    const masterById = inv(masterIds);
    const branchById = inv(branchIds);
    const must = (m: Map<string, string>, k: string, what: string) => {
      const v = m.get(k);
      if (!v) throw new Error(`fixture: unknown ${what} «${k}»`);
      return v;
    };
    const handle: SalonHandle = {
      salonId: salon.id,
      tz,
      salon,
      assistant,
      secrets,
      spec,
      serviceId: (n) => must(serviceIds, n, "service"),
      masterId: (n) => must(masterIds, n, "master"),
      branchId: (n) => must(branchIds, n, "branch"),
      serviceName: (id) => serviceById.get(id) ?? `?${id}`,
      masterName: (id) => masterById.get(id) ?? `?${id}`,
      branchName: (id) => (id ? (branchById.get(id) ?? `?${id}`) : null),
      localDate: (days) => {
        const today = localDateOf(Date.now(), tz);
        const d = new Date(`${today}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
      },
    };
    this.salons.set(salon.id, handle);
    return handle;
  }

  /** Seed an existing booking (what the salon already has in its calendar). */
  addAppointment(
    h: SalonHandle,
    a: {
      master: string;
      service: string;
      date: string;
      time: string;
      phone: string;
      name: string;
      status?: string;
      tag?: string;
    },
  ): Row {
    const svc = this.db.table("services").find((s) => s.id === h.serviceId(a.service))!;
    const start = localToUtcMs(a.date, a.time, h.tz);
    const master = this.db.table("masters").find((m) => m.id === h.masterId(a.master))!;
    return this.db.seed("appointments", {
      salon_id: h.salonId,
      master_id: master.id,
      service_id: svc.id,
      branch_id: master.branch_id,
      client_name: a.name,
      client_phone: a.phone,
      starts_at: new Date(start).toISOString(),
      ends_at: new Date(start + svc.duration_min * 60_000).toISOString(),
      price: svc.price,
      status: a.status ?? "confirmed",
      source: "manual",
      sim_tag: a.tag ?? null,
    });
  }

  /** Master day off (what SalonDayOverridesCard writes). */
  addDayOff(h: SalonHandle, master: string, date: string) {
    this.db.seed("master_day_overrides", {
      master_id: h.masterId(master),
      date,
      is_off: true,
      kind: "off",
      intervals: null,
    });
  }

  /** Book every slot of `master` on `date` except the listed local start times. */
  fillDayExcept(h: SalonHandle, master: string, service: string, date: string, keepFree: string[]) {
    const masterId = h.masterId(master);
    const serviceId = h.serviceId(service);
    let n = 0;
    for (;;) {
      const slots = this.db
        .getAvailableSlots(masterId, serviceId, date)
        .filter((s) => !keepFree.includes(localTimeOf(s.slot_start, h.tz)));
      if (!slots.length) break;
      const s = slots[0];
      this.addAppointment(h, {
        master,
        service,
        date,
        time: localTimeOf(s.slot_start, h.tz),
        phone: `99655500${String(1000 + n++).slice(-4)}`,
        name: `Занято ${n}`,
      });
      if (n > 200) break;
    }
  }

  appointmentsOf(h: SalonHandle): Row[] {
    return this.db.table("appointments").filter((a) => a.salon_id === h.salonId);
  }

  conversationOf(h: SalonHandle, phone: string): Row | undefined {
    return this.db
      .table("wa_conversations")
      .find((c) => c.salon_id === h.salonId && c.client_phone === phone);
  }
}

// ─── Meta webhook payloads ────────────────────────────────────────────────────────────────────

export function inboundPayload(opts: {
  phoneNumberId: string;
  from: string;
  profileName?: string | null;
  text: string;
  wamid: string;
  timestampSec?: number;
}): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "sim-waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id: opts.phoneNumberId,
                display_phone_number: "996700000000",
              },
              contacts: opts.profileName
                ? [{ wa_id: opts.from, profile: { name: opts.profileName } }]
                : [],
              messages: [
                {
                  from: opts.from,
                  id: opts.wamid,
                  timestamp: String(opts.timestampSec ?? Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: opts.text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

/**
 * Эхо ответа администратора — то, чем прод узнаёт про вмешательство человека.
 *
 * Приходит полем `smb_message_echoes`, а НЕ `messages`, и салон в нём ОТПРАВИТЕЛЬ: `from` — номер
 * салона, `to` — клиент. Оба факта — не мелочи: парсер, смотрящий только в `messages`, не увидит
 * вмешательства вообще, а ключ по `from` приклеит паузу к разговору с самим салоном вместо
 * клиента. Ровно на этом Instagram-канал уже обжёгся (см. ig-echo.ts), поэтому воспроизводим
 * форму payload буквально, а не «примерно».
 */
export function echoPayload(opts: {
  phoneNumberId: string;
  salonPhone: string;
  clientPhone: string;
  text: string;
  wamid: string;
}): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "sim-waba",
        changes: [
          {
            field: "smb_message_echoes",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id: opts.phoneNumberId,
                display_phone_number: opts.salonPhone,
              },
              message_echoes: [
                {
                  from: opts.salonPhone,
                  to: opts.clientPhone,
                  id: opts.wamid,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: opts.text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

// ─── client session ───────────────────────────────────────────────────────────────────────────

export type DeliveryOptions = {
  /** Pause between bubbles of one burst (ms). Real people: 1–4 s. */
  gapMs?: number;
  /** Meta redelivers every payload a second time, concurrently. */
  duplicateDelivery?: boolean;
  /** Bubbles arrive in reverse order. */
  outOfOrder?: boolean;
};

export type TurnResult = { replies: string[]; lostInbound: number; reconciled: boolean };

type ProcessFn = (opts: any) => Promise<Response>;

export class ClientSession {
  private seq = 0;
  constructor(
    readonly world: SimWorld,
    readonly salon: SalonHandle,
    readonly phone: string,
    readonly profileName: string | null,
    private readonly process: ProcessFn,
  ) {}

  private repliesSoFar(): number {
    return this.world.transport.outbox.filter((m) => m.to === this.phone).length;
  }

  private deliver(text: string, wamid: string): Promise<Response> {
    return this.process({
      salonId: this.salon.salonId,
      rawBody: inboundPayload({
        phoneNumberId: this.salon.secrets.whatsapp_cloud_phone_number_id,
        from: this.phone,
        profileName: this.profileName,
        text,
        wamid,
      }),
      secrets: this.salon.secrets,
      salon: this.salon.salon,
      assistant: this.salon.assistant,
      rid: `sim-${this.phone.slice(-4)}-${this.seq}`,
      transport: this.world.transport,
      branchId: null,
    });
  }

  /** Send one or more bubbles and wait until the pipeline has fully settled. */
  async say(messages: string[], opts: DeliveryOptions = {}): Promise<TurnResult> {
    const before = this.repliesSoFar();
    const bubbles = messages.map((text) => ({
      text,
      wamid: `wamid.sim.${this.phone}.${++this.seq}`,
    }));
    const ordered = opts.outOfOrder ? [...bubbles].reverse() : bubbles;
    const runs: Promise<Response>[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const b = ordered[i];
      runs.push(this.deliver(b.text, b.wamid));
      if (opts.duplicateDelivery) runs.push(this.deliver(b.text, b.wamid));
      if (i < ordered.length - 1 && opts.gapMs) await new Promise((r) => setTimeout(r, opts.gapMs));
    }
    await Promise.all(runs);

    // A message stored but never answered is a LOST message only while the AI owns the chat.
    // After human takeover the inbound is deliberately kept for the administrator; the AI must
    // stay silent, and the reconcile cron must not process it as an AI backlog.
    const conv = this.world.conversationOf(this.salon, this.phone);
    const pending = conv
      ? this.world.db
          .table("wa_messages")
          .filter(
            (m) => m.conversation_id === conv.id && m.direction === "in" && m.processed_at == null,
          )
      : [];
    let reconciled = false;
    if (pending.length && conv && !conv.ai_paused) {
      reconciled = true;
      await this.process({
        salonId: this.salon.salonId,
        rawBody: JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
        secrets: this.salon.secrets,
        salon: this.salon.salon,
        assistant: this.salon.assistant,
        rid: `sim-reconcile-${this.seq}`,
        transport: this.world.transport,
        forceConversationIds: [conv.id],
      });
    }
    const replies = this.world.transport.outbox
      .filter((m) => m.to === this.phone)
      .slice(before)
      .map((m) => m.text);
    return { replies, lostInbound: conv?.ai_paused ? 0 : pending.length, reconciled };
  }

  /**
   * Администратор салона ответил клиенту сам — из приложения WhatsApp Business.
   *
   * Прод должен на это замолчать на несколько минут: две «администратора» в одном чате — худшее,
   * что клиент может увидеть. Возвращает, встала ли пауза, чтобы сценарий проверял факт, а не
   * верил на слово.
   */
  async adminReply(text: string, opts: { wamid?: string } = {}): Promise<{ paused: boolean }> {
    await this.process({
      salonId: this.salon.salonId,
      rawBody: echoPayload({
        phoneNumberId: this.salon.secrets.whatsapp_cloud_phone_number_id,
        salonPhone: this.salon.secrets.wa_display_phone_number ?? "996700000000",
        clientPhone: this.phone,
        text,
        wamid: opts.wamid ?? `wamid.sim.echo.${this.phone}.${++this.seq}`,
      }),
      secrets: this.salon.secrets,
      salon: this.salon.salon,
      assistant: this.salon.assistant,
      rid: `sim-echo-${this.phone.slice(-4)}-${this.seq}`,
      transport: this.world.transport,
      branchId: null,
    });
    const conv = this.world.conversationOf(this.salon, this.phone);
    return { paused: Boolean(conv?.ai_paused) };
  }

  /** Сколько ответов ассистент отправил этому клиенту за всё время. */
  replyCount(): number {
    return this.repliesSoFar();
  }

  /**
   * wamid последнего сообщения, отправленного САМИМ ассистентом.
   *
   * Нужен ровно для одной проверки: эхо собственного ответа не должно считаться вмешательством
   * человека. В Instagram это уже случалось в проде — ассистент глушил сам себя на пять минут.
   */
  lastOutboundWamid(): string | null {
    const conv = this.world.conversationOf(this.salon, this.phone);
    if (!conv) return null;
    const out = this.world.db
      .table("wa_messages")
      .filter(
        (m) => m.conversation_id === conv.id && m.direction === "out" && m.provider_message_id,
      )
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return out.length ? String(out[out.length - 1].provider_message_id) : null;
  }

  /** Pretend the client went quiet for `hours` (session gap logic reads last_message_at). */
  ageConversation(hours: number) {
    const conv = this.world.conversationOf(this.salon, this.phone);
    if (!conv) return;
    const shift = (iso: string | null) =>
      iso ? new Date(new Date(iso).getTime() - hours * 3_600_000).toISOString() : iso;
    conv.last_message_at = shift(conv.last_message_at);
    conv.session_started_at = shift(conv.session_started_at);
    for (const m of this.world.db.table("wa_messages")) {
      if (m.conversation_id === conv.id) m.created_at = shift(m.created_at);
    }
  }
}

export { localDateOf, localTimeOf, localToUtcMs };
