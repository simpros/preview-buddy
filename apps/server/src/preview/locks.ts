/** Control-plane mutations serialize per (repo, prId) via an in-process queue. */
const previewLocks = new Map<string, Promise<void>>();
const previewLockCounts = new Map<string, number>();

/** Catalog DROP/CREATE serialize per dbName so sweep cannot race provision. */
const dbNameLocks = new Map<string, Promise<void>>();

function previewKey(repo: string, prId: number): string {
  return `${repo}\0${prId}`;
}

function withKeyedLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function withPreviewLock<T>(
  repo: string,
  prId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = previewKey(repo, prId);
  previewLockCounts.set(key, (previewLockCounts.get(key) ?? 0) + 1);
  const run = withKeyedLock(previewLocks, key, fn);
  const release = () => {
    const next = (previewLockCounts.get(key) ?? 1) - 1;
    if (next <= 0) previewLockCounts.delete(key);
    else previewLockCounts.set(key, next);
  };
  run.then(release, release);
  return run;
}

/** Non-blocking variant: returns acquired:false when a deploy holds the lock. */
export function tryWithPreviewLock<T>(
  repo: string,
  prId: number,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  if (isPreviewLocked(repo, prId))
    return Promise.resolve({ acquired: false as const });
  return withPreviewLock(repo, prId, fn).then((value) => ({
    acquired: true as const,
    value,
  }));
}

export function isPreviewLocked(repo: string, prId: number): boolean {
  return (previewLockCounts.get(previewKey(repo, prId)) ?? 0) > 0;
}

export function withDbNameLock<T>(
  dbName: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(dbNameLocks, dbName, fn);
}
