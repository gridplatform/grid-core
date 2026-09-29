import type { GitOpsSettings } from '../types/gitops';
import { syncGitOpsRepo } from './gitopsSyncService';

/** Default snooze interval when GitOps is on but interval is unset/zero in saved settings. */
export const DEFAULT_GITOPS_AUTO_SYNC_SEC = 600;

export function effectiveGitOpsSyncIntervalSec(settings: GitOpsSettings): number {
  if (settings.syncIntervalSec > 0) return settings.syncIntervalSec;
  if (settings.enabled && settings.repoUrl) return DEFAULT_GITOPS_AUTO_SYNC_SEC;
  return 0;
}

/**
 * Fixed-interval GitOps auto-sync (snooze alarm semantics):
 * - fires every `intervalSec`
 * - if a sync is still running, skip this tick (try again on the next interval)
 * - on failure, log only — no immediate retry until the next tick
 */
export function startGitOpsAutoSync(intervalSec: number): () => void {
  if (intervalSec <= 0) {
    return () => undefined;
  }

  const ms = intervalSec * 1000;
  console.log(
    `[gitops] auto-sync every ${intervalSec}s (skips tick while sync in progress; failures retry on next tick)`
  );

  const tick = () => {
    void syncGitOpsRepo({ ifBusy: 'skip' })
      .then((result) => {
        if (result === null) {
          console.log(
            '[gitops] auto-sync skipped — previous sync still in progress; next attempt on schedule'
          );
          return;
        }
        console.log(
          `[gitops] auto-sync ok: ${result.synced} files` +
            (result.commit ? ` @ ${result.commit.slice(0, 8)}` : '')
        );
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[gitops] auto-sync failed (will retry in ${intervalSec}s): ${message}`
        );
      });
  };

  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
}
