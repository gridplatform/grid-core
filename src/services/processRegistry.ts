import type { ChildProcess } from 'child_process';

/** In-flight CLI/terraform children keyed by deployment id or `release:<id>`. */
const childrenByKey = new Map<string, Set<ChildProcess>>();

export function trackChildProcess(key: string, child: ChildProcess): void {
  let set = childrenByKey.get(key);
  if (!set) {
    set = new Set();
    childrenByKey.set(key, set);
  }
  set.add(child);
  const clear = () => {
    set!.delete(child);
    if (set!.size === 0) childrenByKey.delete(key);
  };
  child.once('exit', clear);
  child.once('error', clear);
}

/**
 * SIGTERM then SIGKILL any tracked children for a run.
 * Returns how many processes were signalled.
 */
export function killTrackedProcesses(key: string): number {
  const set = childrenByKey.get(key);
  if (!set || set.size === 0) return 0;
  let n = 0;
  for (const child of [...set]) {
    n += 1;
    try {
      if (!child.killed) child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  // Hard kill shortly after if still alive
  setTimeout(() => {
    for (const child of [...(childrenByKey.get(key) || [])]) {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }, 2_000);
  return n;
}

export function releaseRunKey(releaseId: string): string {
  return `release:${releaseId}`;
}
