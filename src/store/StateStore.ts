import type { App } from "obsidian";
import type { FileRecord, SyncState } from "../types";

const STATE_FILE = ".obsidian/plugins/gdrive-sync/state.json";

const EMPTY_STATE: SyncState = {
  fileRecords: {},
  driveChangesPageToken: "",
  pendingUploads: [],
};

/**
 * Persists and provides access to the sync state:
 * - The file→DriveId mapping (FileRecord per local path)
 * - The Drive Changes API page token
 * - The offline pending-uploads queue
 *
 * Backed by a JSON file in the plugin directory so state survives restarts.
 */
export class StateStore {
  private state: SyncState = structuredClone(EMPTY_STATE);

  constructor(private app: App) {}

  async load(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(STATE_FILE);
      this.state = { ...EMPTY_STATE, ...JSON.parse(raw) };
    } catch {
      // File doesn't exist yet — start fresh
      this.state = structuredClone(EMPTY_STATE);
    }
  }

  async save(): Promise<void> {
    await this.app.vault.adapter.write(
      STATE_FILE,
      JSON.stringify(this.state, null, 2)
    );
  }

  // ──────────────────────────────────────
  // FileRecord accessors
  // ──────────────────────────────────────

  getRecord(localPath: string): FileRecord | undefined {
    return this.state.fileRecords[localPath];
  }

  getRecordByDriveId(driveId: string): FileRecord | undefined {
    return Object.values(this.state.fileRecords).find(
      (r) => r.driveId === driveId
    );
  }

  setRecord(record: FileRecord): void {
    this.state.fileRecords[record.localPath] = record;
  }

  /** Update an existing record's localPath (rename / move). */
  renameRecord(oldPath: string, newPath: string): void {
    const record = this.state.fileRecords[oldPath];
    if (!record) return;
    record.localPath = newPath;
    this.state.fileRecords[newPath] = record;
    delete this.state.fileRecords[oldPath];
  }

  deleteRecord(localPath: string): void {
    delete this.state.fileRecords[localPath];
  }

  allRecords(): FileRecord[] {
    return Object.values(this.state.fileRecords);
  }

  clearRecords(): void {
    this.state.fileRecords = {};
  }

  // ──────────────────────────────────────
  // Changes page token
  // ──────────────────────────────────────

  getPageToken(): string {
    return this.state.driveChangesPageToken;
  }

  setPageToken(token: string): void {
    this.state.driveChangesPageToken = token;
  }

  // ──────────────────────────────────────
  // Pending uploads (offline queue)
  // ──────────────────────────────────────

  addPendingUpload(localPath: string): void {
    if (!this.state.pendingUploads.includes(localPath)) {
      this.state.pendingUploads.push(localPath);
    }
  }

  removePendingUpload(localPath: string): void {
    this.state.pendingUploads = this.state.pendingUploads.filter(
      (p) => p !== localPath
    );
  }

  getPendingUploads(): string[] {
    return [...this.state.pendingUploads];
  }
}
