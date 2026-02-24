import { Hono } from "hono";
import {
  requireAuth,
  requireOrganization,
  type AuthEnv,
} from "../middleware/auth.js";

/**
 * Instance management routes.
 *
 * All routes require authentication (requireAuth) and an active organization
 * (requireOrganization). Instances are scoped to the active organization.
 *
 * Instance ownership model:
 * - "shared" instances (ownerType = "shared", ownerId = null): accessible by
 *   all organization members.
 * - "personal" instances (ownerType = "personal", ownerId = userId): only
 *   accessible by the owning user.
 *
 * GET    /instances          — List organization's instances (shared + user's personal)
 * POST   /instances          — Provision new instance
 * GET    /instances/:id      — Instance details + status
 * DELETE /instances/:id      — Destroy instance
 * POST   /instances/:id/start
 * POST   /instances/:id/stop
 * POST   /instances/:id/restart
 * POST   /instances/:id/token  — Issue auth JWT for instance access
 * GET    /instances/:id/embed  — Redirect to instance with token
 */

const instances = new Hono<AuthEnv>();

// All instance routes require auth + active organization.
instances.use("/*", requireAuth, requireOrganization);

instances.get("/", async (c) => {
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;
  // TODO: Query instances WHERE organizationId = orgId
  //   AND (ownerType = 'shared' OR ownerId = userId)
  return c.json({ instances: [], organizationId: orgId, userId });
});

instances.post("/", async (c) => {
  const orgId = c.get("organizationId");
  const userId = c.get("auth").userId;
  const body = await c.req.json<{
    plan?: string;
    region?: string;
    hostname?: string;
    ownerType?: "shared" | "personal";
  }>();
  const ownerType = body.ownerType || "shared";
  const ownerId = ownerType === "personal" ? userId : null;
  // TODO: Validate plan limits, provision via Provisioner, save to DB with
  //       organizationId, ownerId, and ownerType
  return c.json(
    {
      message: "Instance provisioning started",
      organizationId: orgId,
      ownerId,
      ownerType,
    },
    202,
  );
});

instances.get("/:id", async (c) => {
  const id = c.req.param("id");
  // TODO: Fetch instance from DB, verify org membership + ownership
  return c.json({ id, status: "not_implemented" });
});

instances.delete("/:id", async (c) => {
  const id = c.req.param("id");
  // TODO: Verify ownership, deprovision via Fly API, remove from DB
  return c.json({ id, message: "Instance destruction started" });
});

instances.post("/:id/start", async (c) => {
  const id = c.req.param("id");
  // TODO: Verify ownership, start Fly Machine
  return c.json({ id, message: "Starting" });
});

instances.post("/:id/stop", async (c) => {
  const id = c.req.param("id");
  // TODO: Verify ownership, stop Fly Machine
  return c.json({ id, message: "Stopping" });
});

instances.post("/:id/restart", async (c) => {
  const id = c.req.param("id");
  // TODO: Verify ownership, stop then start Fly Machine
  return c.json({ id, message: "Restarting" });
});

instances.post("/:id/token", async (c) => {
  const id = c.req.param("id");
  // TODO: Verify ownership, fetch instance auth_secret from DB, issue JWT
  return c.json({ id, token: "not_implemented" });
});

instances.get("/:id/embed", async (c) => {
  const id = c.req.param("id");
  // TODO: Verify ownership, issue token, redirect with token cookie
  return c.redirect(`https://${id}.companion.run`);
});

export { instances };
