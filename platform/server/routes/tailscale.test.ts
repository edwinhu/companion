import { describe, it, expect } from "vitest";
import { tailscale } from "./tailscale";

describe("tailscale routes", () => {
  // --- POST /enable --- Enable Tailscale on an instance
  describe("POST /enable", () => {
    it("returns 200 with an enabling message", async () => {
      const res = await tailscale.request("/enable", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ message: "Tailscale enabling" });
    });
  });

  // --- POST /disable --- Disable Tailscale on an instance
  describe("POST /disable", () => {
    it("returns 200 with a disabling message", async () => {
      const res = await tailscale.request("/disable", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ message: "Tailscale disabling" });
    });
  });

  // --- GET /status --- Query Tailscale connection status
  describe("GET /status", () => {
    it("returns 200 with disabled status and null hostname", async () => {
      const res = await tailscale.request("/status");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ enabled: false, hostname: null });
    });
  });
});
