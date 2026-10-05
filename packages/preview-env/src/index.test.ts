import { describe, expect, test } from "bun:test";
import {
  CANONICAL_ENV_KEYS,
  COMPANION_ENV_KEYS,
  ENV_KEY_HOME,
  MAIL_ENV_KEYS,
  SQLITE_ENV_KEYS,
  envProviderMismatch,
  parsePreviewEnvMap,
} from "./env-keys.ts";
import {
  OWNER_ENV_KEYS,
  PREVIEW_ENV_KEYS,
  healthIssueMessage,
  parsePreviewEnvForProvider,
  previewContainerName,
  previewEnvIssueMessage,
} from "./index.ts";

describe("env key partitions", () => {
  test("CANONICAL is owner then companion then sqlite; PREVIEW adds mail", () => {
    expect([...CANONICAL_ENV_KEYS]).toEqual([
      ...OWNER_ENV_KEYS,
      ...COMPANION_ENV_KEYS,
      ...SQLITE_ENV_KEYS,
    ]);
    expect([...PREVIEW_ENV_KEYS]).toEqual([
      ...CANONICAL_ENV_KEYS,
      ...MAIL_ENV_KEYS,
    ]);
    expect(OWNER_ENV_KEYS).toEqual([
      "PGHOST",
      "PGPORT",
      "PGUSER",
      "PGPASSWORD",
      "PGDATABASE",
    ]);
    expect(COMPANION_ENV_KEYS).toEqual(["PGAPPUSER", "PGAPPPASSWORD"]);
    expect(SQLITE_ENV_KEYS).toEqual(["DATABASE_URL"]);
  });

  test("every database key has a home in the map; mail keys stay exempt", () => {
    expect(Object.keys(ENV_KEY_HOME).sort()).toEqual(
      [...CANONICAL_ENV_KEYS].sort(),
    );
    expect(ENV_KEY_HOME.DATABASE_URL).toBe("sqlite");
    expect(ENV_KEY_HOME.PGHOST).toBe("postgres");
  });
});

describe("parsePreviewEnvMap", () => {
  test("absent or empty map means no remapping", () => {
    expect(parsePreviewEnvMap(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(parsePreviewEnvMap({})).toEqual({ ok: true, value: undefined });
  });

  test("accepts identity and partial maps", () => {
    expect(
      parsePreviewEnvMap({ PGHOST: "PGHOST", PGUSER: "DATABASE_USER" }),
    ).toEqual({
      ok: true,
      value: { PGHOST: "PGHOST", PGUSER: "DATABASE_USER" },
    });
  });

  test("accepts PGAPPUSER / PGAPPPASSWORD remap", () => {
    expect(
      parsePreviewEnvMap({
        PGAPPUSER: "APP_DATABASE_USER",
        PGAPPPASSWORD: "APP_DATABASE_PASSWORD",
      }),
    ).toEqual({
      ok: true,
      value: {
        PGAPPUSER: "APP_DATABASE_USER",
        PGAPPPASSWORD: "APP_DATABASE_PASSWORD",
      },
    });
  });

  test("accepts DATABASE_URL remap for sqlite previews", () => {
    expect(parsePreviewEnvMap({ DATABASE_URL: "APP_DATABASE_URL" })).toEqual({
      ok: true,
      value: { DATABASE_URL: "APP_DATABASE_URL" },
    });
  });

  test("accepts mail remaps as cross-provider keys", () => {
    expect(parsePreviewEnvMap({ MAILFROM: "SMTP_FROM" })).toEqual({
      ok: true,
      value: { MAILFROM: "SMTP_FROM" },
    });
  });

  test("rejects unknown keys", () => {
    expect(parsePreviewEnvMap({ REDIS_URL: "REDIS_URL" })).toEqual({
      ok: false,
      issue: { code: "unknown_env_key", key: "REDIS_URL" },
    });
  });

  test("rejects empty targets", () => {
    expect(parsePreviewEnvMap({ PGHOST: "" })).toEqual({
      ok: false,
      issue: { code: "empty_env_target", key: "PGHOST" },
    });
    expect(parsePreviewEnvMap({ PGHOST: "   " })).toEqual({
      ok: false,
      issue: { code: "empty_env_target", key: "PGHOST" },
    });
  });

  test("rejects invalid targets", () => {
    expect(parsePreviewEnvMap({ PGHOST: "bad-name" })).toEqual({
      ok: false,
      issue: { code: "invalid_env_target", key: "PGHOST" },
    });
  });

  test("rejects target collisions", () => {
    expect(
      parsePreviewEnvMap({
        PGHOST: "DATABASE_HOST",
        PGPORT: "DATABASE_HOST",
      }),
    ).toEqual({
      ok: false,
      issue: {
        code: "env_target_collision",
        key: "PGPORT",
        target: "DATABASE_HOST",
        priorKey: "PGHOST",
      },
    });
  });
});

describe("envProviderMismatch", () => {
  test("flags keys from the other provider", () => {
    expect(envProviderMismatch({ PGHOST: "H" }, "sqlite")).toEqual({
      key: "PGHOST",
      home: "postgres",
    });
    expect(envProviderMismatch({ DATABASE_URL: "U" }, "postgres")).toEqual({
      key: "DATABASE_URL",
      home: "sqlite",
    });
    expect(envProviderMismatch({ PGHOST: "H" }, "postgres")).toBeNull();
    expect(
      envProviderMismatch({ DATABASE_URL: "U" }, "sqlite"),
    ).toBeNull();
    expect(envProviderMismatch(undefined, "sqlite")).toBeNull();
  });

  test("none mismatches every database key", () => {
    expect(envProviderMismatch({ PGHOST: "H" }, "none")).toEqual({
      key: "PGHOST",
      home: "postgres",
    });
    expect(envProviderMismatch({ DATABASE_URL: "U" }, "none")).toEqual({
      key: "DATABASE_URL",
      home: "sqlite",
    });
    expect(envProviderMismatch(undefined, "none")).toBeNull();
  });

  test("mail keys are exempt on every provider", () => {
    expect(envProviderMismatch({ MAILFROM: "F" }, "postgres")).toBeNull();
    expect(envProviderMismatch({ MAILFROM: "F" }, "sqlite")).toBeNull();
    expect(envProviderMismatch({ MAILFROM: "F" }, "none")).toBeNull();
  });
});

describe("parsePreviewEnvForProvider", () => {
  test("accepts in-scope keys", () => {
    expect(
      parsePreviewEnvForProvider({ PGHOST: "H" }, "postgres"),
    ).toEqual({ ok: true, value: { PGHOST: "H" } });
    expect(
      parsePreviewEnvForProvider({ DATABASE_URL: "U" }, "sqlite"),
    ).toEqual({ ok: true, value: { DATABASE_URL: "U" } });
  });

  test("rejects out-of-scope keys with their home provider", () => {
    expect(
      parsePreviewEnvForProvider({ DATABASE_URL: "U" }, "postgres"),
    ).toEqual({
      ok: false,
      issue: {
        code: "env_requires_provider",
        key: "DATABASE_URL",
        home: "sqlite",
      },
    });
    expect(parsePreviewEnvForProvider({ PGHOST: "H" }, "none")).toEqual({
      ok: false,
      issue: {
        code: "env_requires_provider",
        key: "PGHOST",
        home: "postgres",
      },
    });
  });

  test("still surfaces shape issues first", () => {
    expect(parsePreviewEnvForProvider({ REDIS_URL: "R" }, "postgres")).toEqual(
      {
        ok: false,
        issue: { code: "unknown_env_key", key: "REDIS_URL" },
      },
    );
  });
});

describe("previewEnvIssueMessage", () => {
  test("covers every issue code under one path", () => {
    expect(previewEnvIssueMessage("preview.env", { code: "unknown_env_key", key: "REDIS_URL" })).toBe(
      "unknown key: preview.env.REDIS_URL",
    );
    expect(previewEnvIssueMessage("preview.env", { code: "empty_env_target", key: "PGHOST" })).toBe(
      "preview.env.PGHOST is required",
    );
    expect(previewEnvIssueMessage("preview.env", { code: "invalid_env_target", key: "PGHOST" })).toBe(
      "preview.env.PGHOST is invalid",
    );
    expect(
      previewEnvIssueMessage("preview.env", {
        code: "env_target_collision",
        key: "PGPORT",
        target: "DATABASE_HOST",
        priorKey: "PGHOST",
      }),
    ).toBe("preview.env: target collision: DATABASE_HOST");
    expect(
      previewEnvIssueMessage("preview.env", {
        code: "env_requires_provider",
        key: "PGHOST",
        home: "postgres",
      }),
    ).toBe("preview.env.PGHOST requires db.provider postgres");
  });
});

describe("healthIssueMessage", () => {
  test("names each health field", () => {
    expect(healthIssueMessage({ code: "invalid_health_path" })).toBe(
      "health.path must start with /",
    );
    expect(healthIssueMessage({ code: "invalid_health_interval" })).toContain(
      "health.interval",
    );
    expect(healthIssueMessage({ code: "invalid_health_timeout" })).toContain(
      "health.timeout",
    );
    expect(healthIssueMessage({ code: "invalid_health_expect" })).toContain(
      "health.expect",
    );
  });
});

describe("previewContainerName", () => {
  test("builds the canonical app container name", () => {
    expect(previewContainerName("widgets", 7)).toBe("sprout-widgets-pr-7");
  });
});
