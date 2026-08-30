import { describe, expect, test } from "bun:test";
import { configSummary, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("fails fast when PB_DATABASE_URL is missing", () => {
    const prev = process.env.PB_DATABASE_URL;
    delete process.env.PB_DATABASE_URL;
    expect(() => loadConfig()).toThrow("PB_DATABASE_URL is required");
    process.env.PB_DATABASE_URL = prev;
  });

  test("applies defaults", () => {
    process.env.PB_DATABASE_URL = "postgres://localhost/postgres";
    delete process.env.PB_DB_PREFIX;
    delete process.env.PB_TTL_HOURS;
    delete process.env.PB_PORT;

    const config = loadConfig();
    expect(config.pbDbPrefix).toBe("prev_pr");
    expect(config.pbTtlHours).toBe(72);
    expect(config.pbPort).toBe(7331);
  });

  test("configSummary redacts secrets", () => {
    const summary = configSummary({
      githubWebhookSecret: "gh-secret",
      gitlabWebhookSecret: "",
      pbDatabaseUrl: "postgres://admin:sekrit@localhost:5432/postgres",
      pbDbPrefix: "prev_pr",
      pbTtlHours: 72,
      pbPort: 7331,
    });

    expect(summary.githubWebhookSecret).toBe("[set]");
    expect(summary.gitlabWebhookSecret).toBe("[unset]");
    expect(String(summary.pbDatabaseUrl)).not.toContain("sekrit");
  });
});
