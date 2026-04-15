import type { DriveClient } from "../drive/DriveClient";
import type { StateStore } from "../store/StateStore";
import type { ChangeQueue } from "./ChangeQueue";
import type { DriveChange } from "../types";

/**
 * Polls the Drive Changes API on an interval and enqueues download/delete
 * operations for remote changes that affect the selected vault folder.
 */
export class RemotePoller {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private drive: DriveClient,
    private store: StateStore,
    private queue: ChangeQueue,
    private folderId: () => string,
    private handleOp: ChangeQueue["enqueue"] extends (op: infer O, h: infer H) => void
      ? (op: O) => Promise<void>
      : never,
    private intervalMin: () => number
  ) {}

  start(): void {
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Immediately run a poll cycle (also called on plugin load). */
  async poll(): Promise<void> {
    const pageToken = this.store.getPageToken();
    if (!pageToken) return; // not yet initialised

    try {
      const { changes, newPageToken } = await this.drive.listChanges(pageToken);
      this.store.setPageToken(newPageToken);
      await this.store.save();

      for (const change of changes) {
        await this.processChange(change);
      }
    } catch (err) {
      console.error("[GDriveSync] Remote poll error:", err);
    }
  }

  private scheduleNext(): void {
    const ms = this.intervalMin() * 60 * 1000;
    this.timer = setInterval(() => this.poll(), ms);
  }

  private async processChange(change: DriveChange): Promise<void> {
    if (change.type !== "file" || !change.fileId) return;

    const existingRecord = this.store.getRecordByDriveId(change.fileId);

    if (change.removed || change.file?.trashed) {
      if (existingRecord) {
        this.queue.enqueue(
          { type: "deleteLocal", localPath: existingRecord.localPath },
          this.handleOp
        );
      }
      return;
    }

    const file = change.file;
    if (!file) return;

    // Skip Google Docs / Sheets / Slides — no local representation
    if (file.mimeType.startsWith("application/vnd.google-apps.")) return;

    // Check this file actually lives under our selected folder
    if (!file.parents?.includes(this.folderId()) && !existingRecord) return;

    const driveMtime = new Date(file.modifiedTime).getTime();

    if (!existingRecord) {
      // New file on Drive — download it
      this.queue.enqueue(
        { type: "download", driveId: file.id, localPath: this.buildLocalPath(file) },
        this.handleOp
      );
    } else {
      // Existing file — SyncEngine will resolve the conflict
      this.queue.enqueue(
        { type: "download", driveId: file.id, localPath: existingRecord.localPath },
        this.handleOp
      );
    }
  }

  /** Derive a local path from a Drive file using the current record store. */
  private buildLocalPath(file: { id: string; name: string; parents?: string[] }): string {
    // Simple case: the file sits directly in the root sync folder.
    // For nested folders, the initial sync populates records with the correct
    // paths; subsequent changes rely on the existing record lookup above.
    return file.name;
  }
}
