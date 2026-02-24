import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { customers, instances, instanceEvents, subscriptions } from "./schema";

// ─── Schema export tests ─────────────────────────────────────────────────────
// Validates that all Drizzle pgTable definitions are properly exported and
// configured with the correct SQL table names, columns, and foreign keys.

describe("schema exports", () => {
  it("exports all four table definitions", () => {
    // Every table should be a truthy, defined object (not null/undefined)
    expect(customers).toBeDefined();
    expect(instances).toBeDefined();
    expect(instanceEvents).toBeDefined();
    expect(subscriptions).toBeDefined();
  });
});

describe("customers table", () => {
  it('uses "customers" as the underlying SQL table name', () => {
    const config = getTableConfig(customers);
    expect(config.name).toBe("customers");
  });

  it("contains all expected column names", () => {
    const config = getTableConfig(customers);
    const columnNames = config.columns.map((c) => c.name);
    // Verify every column declared in the schema is present
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("auth_user_id");
    expect(columnNames).toContain("email");
    expect(columnNames).toContain("name");
    expect(columnNames).toContain("stripe_customer_id");
    expect(columnNames).toContain("plan");
    expect(columnNames).toContain("status");
    expect(columnNames).toContain("created_at");
    expect(columnNames).toContain("updated_at");
  });

  it("has no foreign keys (root table)", () => {
    const config = getTableConfig(customers);
    // customers is a root-level table with no references to other tables
    expect(config.foreignKeys).toHaveLength(0);
  });
});

describe("instances table", () => {
  it('uses "instances" as the underlying SQL table name', () => {
    const config = getTableConfig(instances);
    expect(config.name).toBe("instances");
  });

  it("contains all expected column names", () => {
    const config = getTableConfig(instances);
    const columnNames = config.columns.map((c) => c.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("customer_id");
    expect(columnNames).toContain("fly_machine_id");
    expect(columnNames).toContain("fly_volume_id");
    expect(columnNames).toContain("region");
    expect(columnNames).toContain("hostname");
    expect(columnNames).toContain("custom_domain");
    expect(columnNames).toContain("machine_status");
    expect(columnNames).toContain("auth_secret");
    expect(columnNames).toContain("config");
    expect(columnNames).toContain("tailscale_enabled");
    expect(columnNames).toContain("tailscale_hostname");
    expect(columnNames).toContain("has_active_crons");
    expect(columnNames).toContain("created_at");
    expect(columnNames).toContain("updated_at");
  });

  it("has a foreign key referencing the customers table", () => {
    const config = getTableConfig(instances);
    // instances.customer_id references customers.id
    expect(config.foreignKeys.length).toBeGreaterThanOrEqual(1);
    // Resolve the FK and check the referenced table name
    const fkConfigs = config.foreignKeys.map((fk) => fk.getName());
    const referencesCustomers = config.foreignKeys.some((fk) => {
      const name = fk.getName();
      // Drizzle auto-generates FK names containing both table names
      return name.includes("customers") && name.includes("instances");
    });
    expect(referencesCustomers).toBe(true);
  });
});

describe("instanceEvents table", () => {
  it('uses "instance_events" as the underlying SQL table name', () => {
    const config = getTableConfig(instanceEvents);
    expect(config.name).toBe("instance_events");
  });

  it("contains all expected column names", () => {
    const config = getTableConfig(instanceEvents);
    const columnNames = config.columns.map((c) => c.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("instance_id");
    expect(columnNames).toContain("event_type");
    expect(columnNames).toContain("details");
    expect(columnNames).toContain("created_at");
  });

  it("has a foreign key referencing the instances table", () => {
    const config = getTableConfig(instanceEvents);
    expect(config.foreignKeys.length).toBeGreaterThanOrEqual(1);
    const referencesInstances = config.foreignKeys.some((fk) => {
      const name = fk.getName();
      return name.includes("instances") && name.includes("instance_events");
    });
    expect(referencesInstances).toBe(true);
  });
});

describe("subscriptions table", () => {
  it('uses "subscriptions" as the underlying SQL table name', () => {
    const config = getTableConfig(subscriptions);
    expect(config.name).toBe("subscriptions");
  });

  it("contains all expected column names", () => {
    const config = getTableConfig(subscriptions);
    const columnNames = config.columns.map((c) => c.name);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("customer_id");
    expect(columnNames).toContain("stripe_subscription_id");
    expect(columnNames).toContain("plan");
    expect(columnNames).toContain("status");
    expect(columnNames).toContain("current_period_end");
    expect(columnNames).toContain("created_at");
  });

  it("has a foreign key referencing the customers table", () => {
    const config = getTableConfig(subscriptions);
    expect(config.foreignKeys.length).toBeGreaterThanOrEqual(1);
    const referencesCustomers = config.foreignKeys.some((fk) => {
      const name = fk.getName();
      return name.includes("customers") && name.includes("subscriptions");
    });
    expect(referencesCustomers).toBe(true);
  });
});
