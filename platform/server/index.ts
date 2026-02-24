import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { instances } from "./routes/instances.js";
import { billing, stripeWebhook } from "./routes/billing.js";
import { dashboard } from "./routes/dashboard.js";
import { tailscale } from "./routes/tailscale.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3457;

const app = new Hono();

// ── CORS ─────────────────────────────────────────────────────────────────────
// credentials: true allows Better Auth session cookies to be sent cross-origin.
// origin must be set explicitly when credentials is true.
app.use(
  "/api/*",
  cors({
    origin: (origin) => origin,
    credentials: true,
  }),
);

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ ok: true }));

// ── Better Auth ──────────────────────────────────────────────────────────────
// Mount the Better Auth handler for all auth routes. This is a catch-all that
// delegates to Better Auth's built-in endpoints (sign-up, sign-in, session,
// organization CRUD, team CRUD, invitations, etc.).
// Uses lazy import to avoid crashing when env vars aren't set (e.g. in tests
// that don't exercise auth routes).
app.all("/api/auth/*", async (c) => {
  const { getAuth } = await import("./auth.js");
  return getAuth().handler(c.req.raw);
});

// ── API Routes ───────────────────────────────────────────────────────────────
app.route("/api/instances", instances);
app.route("/api/billing", billing);
app.route("/api/webhooks", stripeWebhook);
app.route("/api/dashboard", dashboard);

app.get("/api/status", (c) => {
  return c.json({
    service: "companion-cloud",
    version: "0.1.0",
    status: "ok",
  });
});

// ── Static files (production only, Bun runtime) ─────────────────────────────
// Dynamic import avoids "Bun is not defined" when running under Node/vitest.
if (process.env.NODE_ENV === "production") {
  const { serveStatic } = await import("hono/bun");
  const distDir = resolve(__dirname, "../dist");
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", serveStatic({ path: resolve(distDir, "index.html") }));
}

// ── Start ────────────────────────────────────────────────────────────────────
export default {
  port,
  fetch: app.fetch,
};

console.log(`[companion-cloud] Control plane running on http://localhost:${port}`);
