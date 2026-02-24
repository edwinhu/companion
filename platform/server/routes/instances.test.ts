import { describe, it, expect } from "vitest";
import { instances } from "./instances";

describe("instances routes", () => {
  // --- GET / --- List all instances for the authenticated customer
  describe("GET /", () => {
    it("returns 200 with an empty instances array", async () => {
      const res = await instances.request("/");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ instances: [] });
    });
  });

  // --- POST / --- Provision a new instance
  describe("POST /", () => {
    it("returns 202 with a provisioning-started message", async () => {
      const res = await instances.request("/", { method: "POST" });
      expect(res.status).toBe(202);

      const body = await res.json();
      expect(body).toEqual({ message: "Instance provisioning started" });
    });
  });

  // --- GET /:id --- Fetch details for a single instance
  describe("GET /:id", () => {
    it("returns 200 with the requested id and a not_implemented status", async () => {
      const res = await instances.request("/inst-abc-123");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ id: "inst-abc-123", status: "not_implemented" });
    });

    it("passes through the id param correctly for different ids", async () => {
      const res = await instances.request("/another-id-456");
      const body = await res.json();
      expect(body.id).toBe("another-id-456");
    });
  });

  // --- DELETE /:id --- Destroy an instance
  describe("DELETE /:id", () => {
    it("returns 200 with the id and a destruction-started message", async () => {
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
    it("returns 200 with the id and a Starting message", async () => {
      const res = await instances.request("/inst-s1/start", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ id: "inst-s1", message: "Starting" });
    });
  });

  // --- POST /:id/stop --- Stop an instance
  describe("POST /:id/stop", () => {
    it("returns 200 with the id and a Stopping message", async () => {
      const res = await instances.request("/inst-s2/stop", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ id: "inst-s2", message: "Stopping" });
    });
  });

  // --- POST /:id/restart --- Restart an instance
  describe("POST /:id/restart", () => {
    it("returns 200 with the id and a Restarting message", async () => {
      const res = await instances.request("/inst-s3/restart", {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ id: "inst-s3", message: "Restarting" });
    });
  });

  // --- POST /:id/token --- Issue an auth token for instance access
  describe("POST /:id/token", () => {
    it("returns 200 with the id and a not_implemented token", async () => {
      const res = await instances.request("/inst-t1/token", {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ id: "inst-t1", token: "not_implemented" });
    });
  });

  // --- GET /:id/embed --- Redirect to the instance's companion.run hostname
  describe("GET /:id/embed", () => {
    it("returns a 302 redirect", async () => {
      const res = await instances.request("/my-instance/embed", {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
    });

    it("sets the Location header to https://{id}.companion.run", async () => {
      const res = await instances.request("/my-instance/embed", {
        redirect: "manual",
      });
      expect(res.headers.get("Location")).toBe(
        "https://my-instance.companion.run"
      );
    });
  });
});
