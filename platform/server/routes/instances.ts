import { Hono } from "hono";

/**
 * Instance management routes.
 *
 * All routes require authentication (Better Auth session).
 * TODO: Add Better Auth middleware to verify session and extract customer ID.
 * TODO: Add ownership check — verify the customer owns the instance before
 *       allowing operations (start/stop/delete/token/embed).
 *
 * GET    /instances          — List customer's instances
 * POST   /instances          — Provision new instance
 * GET    /instances/:id      — Instance details + status
 * DELETE /instances/:id      — Destroy instance
 * POST   /instances/:id/start
 * POST   /instances/:id/stop
 * POST   /instances/:id/restart
 * POST   /instances/:id/token  — Issue auth JWT for instance access
 * GET    /instances/:id/embed  — Redirect to instance with token
 */

const instances = new Hono();

instances.get("/", async (c) => {
  // TODO: Get customer from session, list their instances from DB
  return c.json({ instances: [] });
});

instances.post("/", async (c) => {
  // TODO: Validate plan, create instance via Provisioner, save to DB
  return c.json({ message: "Instance provisioning started" }, 202);
});

instances.get("/:id", async (c) => {
  const id = c.req.param("id");
  // TODO: Fetch instance from DB, check ownership, return details
  return c.json({ id, status: "not_implemented" });
});

instances.delete("/:id", async (c) => {
  const id = c.req.param("id");
  // TODO: Deprovision via Fly API, remove from DB
  return c.json({ id, message: "Instance destruction started" });
});

instances.post("/:id/start", async (c) => {
  const id = c.req.param("id");
  // TODO: Start Fly Machine
  return c.json({ id, message: "Starting" });
});

instances.post("/:id/stop", async (c) => {
  const id = c.req.param("id");
  // TODO: Stop Fly Machine
  return c.json({ id, message: "Stopping" });
});

instances.post("/:id/restart", async (c) => {
  const id = c.req.param("id");
  // TODO: Stop then start Fly Machine
  return c.json({ id, message: "Restarting" });
});

instances.post("/:id/token", async (c) => {
  const id = c.req.param("id");
  // TODO: Fetch instance auth_secret from DB, issue JWT
  return c.json({ id, token: "not_implemented" });
});

instances.get("/:id/embed", async (c) => {
  const id = c.req.param("id");
  // TODO: Issue token, redirect to instance hostname with token cookie
  return c.redirect(`https://${id}.companion.run`);
});

export { instances };
