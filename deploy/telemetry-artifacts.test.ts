import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const deployDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(deployDir, "..");

const ENDPOINT_KEY = "SPROUT_TELEMETRY_ENDPOINT";
const AUTH_KEY = "SPROUT_TELEMETRY_AUTH";

// A value assignment is KEY= followed by a non-space value that is not a
// variable reference ($...); empty defaults and ${...} templates are allowed.
const ASSIGNMENT = new RegExp(
  `SPROUT_TELEMETRY_(?:ENDPOINT|AUTH)=(\\S+)`,
);

async function trackedFiles(): Promise<string[]> {
  const proc = Bun.spawnSync(["git", "ls-files"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error("git ls-files failed");
  return proc.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

describe("telemetry destination hygiene", () => {
  test("Dockerfile declares both ARGs empty and re-exports them as ENV", async () => {
    const text = await Bun.file(join(repoRoot, "Dockerfile")).text();
    for (const key of [ENDPOINT_KEY, AUTH_KEY]) {
      const arg = text
        .split("\n")
        .find((line) => line.startsWith(`ARG ${key}=`));
      expect(arg, `missing ARG ${key}`).toBe(`ARG ${key}=`);
      expect(
        text
          .split("\n")
          .some((line) => line.startsWith(`ENV ${key}`)),
        `missing ENV ${key}`,
      ).toBe(true);
    }
    // Value hygiene for every tracked file, Dockerfile included, lives in
    // the scan below (which exempts ${...} references).
  });

  test("release.yml passes both values as build-args", async () => {
    const text = await Bun.file(
      join(repoRoot, ".github/workflows/release.yml"),
    ).text();
    const doc = Bun.YAML.parse(text) as {
      jobs: Record<string, { steps?: Array<Record<string, unknown>> }>;
    };
    const steps = doc.jobs.docker?.steps ?? [];
    const build = steps.find(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("docker/build-push-action@"),
    );
    const buildArgs = String(
      (build?.with as Record<string, unknown> | undefined)?.["build-args"] ??
        "",
    );
    expect(buildArgs).toContain(ENDPOINT_KEY);
    expect(buildArgs).toContain(AUTH_KEY);
    // The values arrive from a repository variable and secret, never source.
    expect(buildArgs).toContain("vars.SPROUT_TELEMETRY_ENDPOINT");
    expect(buildArgs).toContain("secrets.SPROUT_TELEMETRY_AUTH");
    // Upstream releases fail without a destination; forks only warn.
    expect(text).toContain("github.repository == 'simpros/sprout'");
  });

  test("no tracked file carries a destination value", async () => {
    const offenders: string[] = [];
    for (const rel of await trackedFiles()) {
      let text: string;
      try {
        text = await Bun.file(join(repoRoot, rel)).text();
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        const match = ASSIGNMENT.exec(line);
        if (match && !match[1]?.startsWith("$")) {
          offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
