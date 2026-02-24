/**
 * Landing page with pricing and sign-up CTA.
 * TODO: Replace with full marketing page + Better Auth sign-up.
 */
export function Landing() {
  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: 40, fontFamily: "system-ui" }}>
      <h1>Companion Cloud</h1>
      <p>
        Deploy a managed instance of The Companion — the web UI for Claude Code
        &amp; Codex. No setup, no servers, just code.
      </p>

      {/* Pricing tiers — agent and instance limits are soft limits for now.
          TODO: Enforce limits in provisioner and instance routes when
          Better Auth + DB integration is complete. */}
      <h2>Pricing</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, marginTop: 20 }}>
        <PricingCard
          name="Starter"
          price="$29/mo"
          features={["1 instance", "2 CPU / 2GB RAM", "10GB storage", "3 agents"]}
        />
        <PricingCard
          name="Pro"
          price="$79/mo"
          features={["1 instance", "4 CPU / 4GB RAM", "50GB storage", "Custom domain", "Tailscale", "10 agents"]}
          highlighted
        />
        <PricingCard
          name="Enterprise"
          price="$149/mo"
          features={["3 instances", "4 CPU / 8GB RAM", "100GB storage", "Custom domain", "Tailscale", "Unlimited agents", "Priority support"]}
        />
      </div>

      <div style={{ textAlign: "center", marginTop: 40 }}>
        <a
          href="#/dashboard"
          style={{
            display: "inline-block",
            padding: "12px 32px",
            background: "#000",
            color: "#fff",
            borderRadius: 8,
            textDecoration: "none",
            fontSize: 16,
          }}
        >
          Get Started
        </a>
      </div>
    </div>
  );
}

function PricingCard({
  name,
  price,
  features,
  highlighted,
}: {
  name: string;
  price: string;
  features: string[];
  highlighted?: boolean;
}) {
  return (
    <div
      style={{
        border: highlighted ? "2px solid #000" : "1px solid #ddd",
        borderRadius: 12,
        padding: 24,
        textAlign: "center",
      }}
    >
      <h3>{name}</h3>
      <p style={{ fontSize: 28, fontWeight: 700, margin: "8px 0" }}>{price}</p>
      <ul style={{ listStyle: "none", padding: 0, textAlign: "left" }}>
        {features.map((f) => (
          <li key={f} style={{ padding: "4px 0" }}>
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}
