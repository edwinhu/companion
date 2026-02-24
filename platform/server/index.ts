import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3457;

const app = new Hono();

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use("/api/*", cors());

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ ok: true }));

// ── API Routes ───────────────────────────────────────────────────────────────
// TODO: Mount Better Auth routes at /api/auth/*
// TODO: Mount instance routes at /api/instances/*
// TODO: Mount billing routes at /api/billing/*
// TODO: Mount Tailscale routes at /api/instances/:id/tailscale/*
// TODO: Mount dashboard routes at /api/dashboard/*

app.get("/api/status", (c) => {
  return c.json({
    service: "companion-cloud",
    version: "0.1.0",
    status: "ok",
  });
});

// ── Static files (production) ────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
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
