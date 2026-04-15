/**
 * Determines the winning version when the same file was modified both locally
 * and on Drive since the last sync.
 *
 * Strategy: last-write-wins based on modification timestamps.
 */

export type ConflictWinner = "local" | "remote";

export interface ConflictContext {
  localMtime: number;  // ms epoch of the local file's current mtime
  driveMtime: number;  // ms epoch of Drive's modifiedTime
  syncedAt: number;    // ms epoch of last successful sync
}

export class ConflictResolver {
  /**
   * Returns "local" if the local version should be uploaded (local is newer),
   * or "remote" if the Drive version should be downloaded.
   */
  resolve(ctx: ConflictContext): ConflictWinner {
    // If only one side changed since syncedAt, there is no real conflict.
    const localChanged = ctx.localMtime > ctx.syncedAt;
    const remoteChanged = ctx.driveMtime > ctx.syncedAt;

    if (localChanged && !remoteChanged) return "local";
    if (remoteChanged && !localChanged) return "remote";

    // Both changed — last-write-wins.
    return ctx.localMtime >= ctx.driveMtime ? "local" : "remote";
  }
}
