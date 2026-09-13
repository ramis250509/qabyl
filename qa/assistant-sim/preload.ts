// Loaded with `bun --preload` before the runner. Replaces the service-role Supabase client with the
// in-memory FakeSupabase BY RESOLVED FILE PATH, so every import spelling (`@/integrations/...`,
// relative) gets the fake — and nothing in src/ has to know a simulator exists.
import { plugin } from "bun";

// Billing metering switches itself off without a service-role key; a real key in the shell must
// never make the simulator bill a real salon.
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.PUBLIC_APP_URL = process.env.PUBLIC_APP_URL ?? "https://qabyl.com";

plugin({
  name: "qabyl-sim-supabase",
  setup(build) {
    build.onLoad({ filter: /integrations[\\/]supabase[\\/]client\.server\.ts$/ }, () => ({
      loader: "ts",
      contents: `
        export const supabaseAdmin = new Proxy({}, {
          get(_t, prop) {
            const db = (globalThis as any).__QABYL_SIM_DB__;
            if (!db) throw new Error("assistant-sim: fake database is not installed");
            const v = db[prop];
            return typeof v === "function" ? v.bind(db) : v;
          },
        });
      `,
    }));
  },
});
