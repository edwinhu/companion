import { describe, it, expect } from "vitest";
import { dashboard } from "./dashboard";

describe("dashboard routes", () => {
  // --- GET /usage --- Return aggregated usage metrics for billing display
  describe("GET /usage", () => {
    it("returns 200 with zeroed-out usage metrics", async () => {
      const res = await dashboard.request("/usage");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        instances: 0,
        uptimeHours: 0,
        agentRuns: 0,
        storageUsedGb: 0,
      });
    });
  });
});
