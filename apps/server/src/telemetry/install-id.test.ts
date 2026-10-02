import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installIdPathFor,
  loadOrCreateInstallId,
} from "./install-id.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function tempStateDbPath(): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sprout-install-id-"));
  return { dir, dbPath: join(dir, "sprout.db") };
}

describe("install identity", () => {
  test("creates install-id with mode 0600 and a valid UUIDv4 body", async () => {
    const { dir, dbPath } = await tempStateDbPath();
    try {
      const id = await loadOrCreateInstallId(dbPath);
      expect(id).toMatch(UUID_V4);
      expect(installIdPathFor(dbPath)).toBe(join(dir, "install-id"));
      expect((await Bun.file(join(dir, "install-id")).text()).trim()).toBe(id);
      const mode = (await stat(join(dir, "install-id"))).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a restart reuses the same id", async () => {
    const { dir, dbPath } = await tempStateDbPath();
    try {
      const first = await loadOrCreateInstallId(dbPath);
      const second = await loadOrCreateInstallId(dbPath);
      expect(second).toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deleting the file yields a new identity", async () => {
    const { dir, dbPath } = await tempStateDbPath();
    try {
      const first = await loadOrCreateInstallId(dbPath);
      await unlink(join(dir, "install-id"));
      const second = await loadOrCreateInstallId(dbPath);
      expect(second).not.toBe(first);
      expect(second).toMatch(UUID_V4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("two gateways with different state dirs never share an id", async () => {
    const first = await tempStateDbPath();
    const second = await tempStateDbPath();
    try {
      const ids = new Set<string>();
      for (let i = 0; i < 5; i += 1) {
        ids.add(await loadOrCreateInstallId(first.dbPath));
        ids.add(await loadOrCreateInstallId(second.dbPath));
      }
      expect(ids.size).toBe(2);
    } finally {
      await rm(first.dir, { recursive: true, force: true });
      await rm(second.dir, { recursive: true, force: true });
    }
  });
});
