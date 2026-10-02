/** Control-plane mutations serialize per (repo, prId) via an in-process queue. */
function previewKey(repo: string, prId: number): string {
  return `${repo}\0${prId}`;
}

/**
 * One keyed lock owns both its queue and its occupancy count, so no caller
 * can observe them disagreeing.
 */
function createKeyedLock() {
  const locks = new Map<string, Promise<void>>();
  const counts = new Map<string, number>();

  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    const release = () => {
      const next = (counts.get(key) ?? 1) - 1;
      if (next <= 0) counts.delete(key);
      else counts.set(key, next);
    };
    run.then(release, release);
    return run;
  }

  /** Non-blocking variant: acquired:false when a holder is inside. */
  function tryWithLock<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    if ((counts.get(key) ?? 0) > 0) {
      return Promise.resolve({ acquired: false as const });
    }
    return withLock(key, fn).then((value) => ({
      acquired: true as const,
      value,
    }));
  }

  return { withLock, tryWithLock };
}

const previewLock = createKeyedLock();

/** Catalog DROP/CREATE serialize per dbName so sweep cannot race provision. */
const dbNameLock = createKeyedLock();

export function withPreviewLock<T>(
  repo: string,
  prId: number,
  fn: () => Promise<T>,
): Promise<T> {
  return previewLock.withLock(previewKey(repo, prId), fn);
}

/** Non-blocking variant: returns acquired:false when a deploy holds the lock. */
export function tryWithPreviewLock<T>(
  repo: string,
  prId: number,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return previewLock.tryWithLock(previewKey(repo, prId), fn);
}

export function withDbNameLock<T>(
  dbName: string,
  fn: () => Promise<T>,
): Promise<T> {
  return dbNameLock.withLock(dbName, fn);
}
