import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for instance management routes.
 *
 * The auth middleware (requireAuth + requireOrganization) is mocked to
 * inject a fixed user/org context, so we can test the route handlers
 * directly without a real Better Auth session.
 */

// Mock the auth module so requireAuth/requireOrganization pass through
// with injected context variables.
const MOCK_USER_ID = "user-test-1";
const MOCK_ORG_ID = "org-test-1";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: vi.fn(async (c: any, next: any) => {
    c.set("auth", {
      userId: MOCK_USER_ID,
      user: { id: MOCK_USER_ID, email: "test@example.com", name: "Test" },
      activeOrganizationId: MOCK_ORG_ID,
    });
    await next();
  }),
  requireOrganization: vi.fn(async (c: any, next: any) => {
    c.set("organizationId", MOCK_ORG_ID);
    await next();
  }),
}));

// Import after mocks are set up.
const { instances } = await import("./instances");

describe("instances routes", () => {
  // --- GET / --- List all instances for the org
  describe("GET /", () => {
    it("returns 200 with the organization and user context", async () => {
      const res = await instances.request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.instances).toEqual([]);
      expect(body.organizationId).toBe(MOCK_ORG_ID);
      expect(body.userId).toBe(MOCK_USER_ID);
    });
  });

  // --- POST / --- Provision a new instance
  describe("POST /", () => {
    it("returns 202 with a shared instance by default", async () => {
      const res = await instances.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "starter" }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.message).toBe("Instance provisioning started");
      expect(body.organizationId).toBe(MOCK_ORG_ID);
      expect(body.ownerType).toBe("shared");
      expect(body.ownerId).toBeNull();
    });

    it("sets ownerId when ownerType is personal", async () => {
      const res = await instances.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerType: "personal" }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.ownerType).toBe("personal");
      expect(body.ownerId).toBe(MOCK_USER_ID);
    });
  });

  // --- GET /:id --- Fetch details for a single instance
  describe("GET /:id", () => {
    it("returns 200 with the requested id", async () => {
      const res = await instances.request("/inst-abc-123");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ id: "inst-abc-123", status: "not_implemented" });
    });
  });

  // --- DELETE /:id --- Destroy an instance
  describe("DELETE /:id", () => {
    it("returns 200 with the id and a destruction message", async () => {
      const res = await instances.request("/inst-del-1", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        id: "inst-del-1",
        message: "Instance destruction started",
      });
    });
  });

  // --- POST /:id/start --- Start an instance
  describe("POST /:id/start", () => {
    it("returns 200 with a Starting message", async () => {
      const res = await instances.request("/inst-s1/start", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ id: "inst-s1", message: "Starting" });
    });
  });

  // --- POST /:id/stop --- Stop an instance
  describe("POST /:id/stop", () => {
    it("returns 200 with a Stopping message", async () => {
      const res = await instances.request("/inst-s2/stop", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ id: "inst-s2", message: "Stopping" });
    });
  });

  // --- POST /:id/restart --- Restart an instance
  describe("POST /:id/restart", () => {
    it("returns 200 with a Restarting message", async () => {
      const res = await instances.request("/inst-s3/restart", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ id: "inst-s3", message: "Restarting" });
    });
  });

  // --- POST /:id/token --- Issue an auth token
  describe("POST /:id/token", () => {
    it("returns 200 with a not_implemented token stub", async () => {
      const res = await instances.request("/inst-t1/token", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ id: "inst-t1", token: "not_implemented" });
    });
  });

  // --- GET /:id/embed --- Redirect to instance hostname
  describe("GET /:id/embed", () => {
    it("returns a 302 redirect to the instance's companion.run hostname", async () => {
      const res = await instances.request("/my-instance/embed", {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(
        "https://my-instance.companion.run",
      );
    });
  });
});
