import { chmod, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The install identity lives next to the state database, never in it. */
export function installIdPathFor(stateDbPath: string): string {
  return join(dirname(stateDbPath.trim()), "install-id");
}

/**
 * Lazily-created install identity: a random UUIDv4 plus newline, mode 0600.
 * Never derived from hostname, machine-id, MAC, user, repo or environment.
 * Deleting the file ends the identity, so no reset command is needed.
 */
export async function loadOrCreateInstallId(
  stateDbPath: string,
): Promise<string> {
  const path = installIdPathFor(stateDbPath);
  try {
    const existing = (await Bun.file(path).text()).trim();
    if (UUID_V4_PATTERN.test(existing)) return existing;
  } catch {
    // Missing or unreadable: fall through and mint a fresh identity.
  }
  const id = crypto.randomUUID();
  await writeFile(path, `${id}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return id;
}
