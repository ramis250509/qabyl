import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const db = new PGlite();
const salon = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table salons(id uuid primary key);
    create table billing_plans(code text primary key,name text,price_kgs integer,is_active boolean default true,limits jsonb,updated_at timestamptz);
    create table salon_subscriptions(salon_id uuid primary key references salons(id),plan_code text,status text,
      auto_topup boolean default true,billing_exempt boolean default false,cancel_at_period_end boolean default false,
      current_period_start timestamptz,current_period_end timestamptz,pending_plan_code text,grace_until timestamptz,
      last_payment_error text,card_mask text,updated_at timestamptz);
    create table billing_invoices(id uuid primary key default gen_random_uuid(),salon_id uuid references salons(id),kind text,
      amount_kgs integer,provider text,plan_code text,period_start timestamptz,period_end timestamptz,metadata jsonb,
      status text default 'pending',paid_at timestamptz,provider_payment_id text,last_error text,next_attempt_at timestamptz,
      created_at timestamptz default now(),updated_at timestamptz);
    create unique index on billing_invoices(provider,provider_payment_id);
    create table billing_payment_methods(salon_id uuid primary key,provider text,card_token text,recurring_profile_id text,card_mask text,updated_at timestamptz);
    create table billing_credits(id uuid default gen_random_uuid(),salon_id uuid,period_start timestamptz,messages integer,source text,invoice_id uuid);
    create table billing_events(salon_id uuid,type text,payload jsonb);
    create table notifications(salon_id uuid,type text,title text,body text);
    create function billing_current_period_start(uuid) returns timestamptz language sql as 'select now()';
    create function billing_salon_state(uuid) returns jsonb language sql as 'select ''{"exempt":false,"messages_allowance":1000,"messages_used":900}''::jsonb';
    insert into salons values('${salon}'),('${other}');
    insert into billing_plans values('business','Business',6499,true,'{"overage_pack_messages":500,"overage_pack_price_kgs":1190}',now());
    insert into salon_subscriptions(salon_id,plan_code,status) values('${salon}','business','active'),('${other}','business','active');
  `);
  const sql = await readFile(
    new URL("./supabase/migrations/20260913151910_payment_safety.sql", import.meta.url),
    "utf8",
  );
  await db.exec(sql);
  await db.exec(sql); // Deployment replay must be harmless.
}, 30000);
afterAll(() => db.close());

async function reserve(kind: string, metadata: object, tenant = salon) {
  const result = await db.query<{ id: string }>(
    "select billing_reserve_invoice($1,$2::jsonb) as id",
    [tenant, JSON.stringify({ kind, metadata, amount_kgs: 1190, provider: "freedompay" })],
  );
  return result.rows[0].id;
}
describe("payment database transactions", () => {
  test("two tabs cannot create two pending purchases", async () => {
    const results = await Promise.allSettled([
      reserve("overage_pack", { messages: 500 }),
      reserve("overage_pack", { messages: 500 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  test("duplicate callbacks credit only once; late failure cannot undo success", async () => {
    const id = (
      await db.query<{ id: string }>("select id from billing_invoices where salon_id=$1", [salon])
    ).rows[0].id;
    const args = [
      id,
      "payment:123:paid",
      "paid",
      JSON.stringify({ paymentId: "123", cardMask: "**** 1234" }),
    ];
    await Promise.all([
      db.query("select billing_receive_event($1,$2,$3,$4::jsonb)", args),
      db.query("select billing_receive_event($1,$2,$3,$4::jsonb)", args),
    ]);
    await db.query("select billing_receive_event($1,'payment:123:failed','failed','{}')", [id]);
    expect(
      (await db.query("select * from billing_credits where invoice_id=$1", [id])).rows,
    ).toHaveLength(1);
    expect(
      (await db.query<{ status: string }>("select status from billing_invoices where id=$1", [id]))
        .rows[0].status,
    ).toBe("paid");
  });
  test("failed entitlement rolls back invoice and webhook receipt", async () => {
    const id = await reserve("overage_pack", { messages: 0 }, other);
    await expect(
      db.query("select billing_receive_event($1,'broken','paid','{}')", [id]),
    ).rejects.toThrow();
    expect(
      (await db.query<{ status: string }>("select status from billing_invoices where id=$1", [id]))
        .rows[0].status,
    ).toBe("pending");
    expect(
      (await db.query("select * from payment_webhook_events where event_key='broken'")).rows,
    ).toHaveLength(0);
    await db.query("update billing_invoices set status='canceled' where id=$1", [id]);
  });
  test("auto topup reservation is atomic and disable cancels undispatched debit", async () => {
    await db.query(
      "update salon_subscriptions set auto_topup=true,auto_topup_consent_at=now() where salon_id=$1",
      [other],
    );
    await db.query(
      "insert into billing_payment_methods(salon_id,card_token) values($1,'safe-reference')",
      [other],
    );
    await db.query(
      "update billing_invoices set created_at=now()-interval '2 days' where salon_id=$1",
      [other],
    );
    const results = await Promise.all([
      db.query<{ id: string }>("select billing_reserve_topup($1) id", [other]),
      db.query<{ id: string }>("select billing_reserve_topup($1) id", [other]),
    ]);
    const ids = results.map((r) => r.rows[0].id).filter(Boolean);
    expect(ids).toHaveLength(1);
    await db.query("update salon_subscriptions set auto_topup=false where salon_id=$1", [other]);
    expect(
      (await db.query<{ ok: boolean }>("select billing_claim_dispatch($1,$2) ok", [other, ids[0]]))
        .rows[0].ok,
    ).toBe(false);
  });
  test("dispatch cannot cross tenant boundaries", async () => {
    const id = await reserve("card_check", {}, other);
    await expect(db.query("select billing_claim_dispatch($1,$2)", [salon, id])).rejects.toThrow();
    expect(
      (await db.query<{ ok: boolean }>("select billing_claim_dispatch($1,$2) ok", [other, id]))
        .rows[0].ok,
    ).toBe(true);
    expect(
      (await db.query<{ ok: boolean }>("select billing_claim_dispatch($1,$2) ok", [other, id]))
        .rows[0].ok,
    ).toBe(false);
  });
  test("untrusted roles cannot execute settlement or read routing secrets", async () => {
    await db.exec("set role authenticated");
    try {
      await expect(db.query("select billing_settle_invoice(null,'{}')")).rejects.toThrow();
      await expect(db.query("select * from payment_accounts")).rejects.toThrow();
      await expect(db.query("select * from payment_webhook_events")).rejects.toThrow();
    } finally {
      await db.exec("reset role");
    }
  });
});
