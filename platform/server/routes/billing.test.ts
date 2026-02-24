import { describe, it, expect } from "vitest";
import { billing, stripeWebhook } from "./billing";

describe("billing routes", () => {
  // --- POST /checkout --- Create a Stripe Checkout Session
  describe("POST /checkout", () => {
    it("returns 200 with a Stripe checkout URL", async () => {
      const res = await billing.request("/checkout", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ url: "https://checkout.stripe.com/..." });
    });
  });

  // --- POST /portal --- Create a Stripe Customer Portal link
  describe("POST /portal", () => {
    it("returns 200 with a Stripe billing portal URL", async () => {
      const res = await billing.request("/portal", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ url: "https://billing.stripe.com/..." });
    });
  });
});

describe("stripeWebhook routes", () => {
  // --- POST /stripe --- Handle incoming Stripe webhook events
  describe("POST /stripe", () => {
    it("returns 200 with { received: true }", async () => {
      const res = await stripeWebhook.request("/stripe", { method: "POST" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ received: true });
    });
  });
});
