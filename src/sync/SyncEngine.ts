import type { App } from "obsidian";
import type { DriveClient } from "../drive/DriveClient";
import type { StateStore } from "../store/StateStore";
import { ChangeQueue, type ChangeOp } from "./ChangeQueue";
import { ConflictResolver } from "./ConflictResolver";
import { LocalWatcher } from "./LocalWatcher";
import { RemotePoller } from "./RemotePoller";
import type { GDriveSyncSettings, FileRecord } from "../types";

export type SyncStatus = "idle" | "syncing" | "error" | "offline";

export class SyncEngine {
  readonly queue: ChangeQueue;
  private resolver: ConflictResolver;
  private watcher: LocalWatcher;
  private poller: RemotePoller;

  private _status: SyncStatus = "idle";
  private _lastError: string | null = null;
  onStatusChange?: (status: SyncStatus, error?: string) => void;

  constructor(
    private app: App,
    private drive: DriveClient,
    private store: StateStore,
    private settings: GDriveSyncSettings
  ) {
    this.queue = new ChangeQueue();
    this.resolver = new ConflictResolver();

    const handleOp = this.processOp.bind(this);

    this.watcher = new LocalWatcher(app, settings, this.queue, handleOp);
    this.poller = new RemotePoller(
      drive,
      store,
      this.queue,
      () => settings.folderId,
      handleOp,
      () => settings.pollIntervalMin
    );
  }

  start(): void {
    this.watcher.start();
    this.poller.start();
    this.poller.poll(); // immediate first poll
    this.flushPendingUploads();
  }

  stop(): void {
    this.watcher.stop();
    this.poller.stop();
    this.queue.clear();
  }

  get status(): SyncStatus { return this._status; }
  get lastError(): string | null { return this._lastError; }

  // ──────────────────────────────────────
  // Initial vault sync (called once after folder selection)
  // ──────────────────────────────────────

  async initialSync(): Promise<void> {
    this.setStatus("syncing");
    try {
      const rootFolderId = this.settings.folderId;

      // 1. Get page token FIRST so we don't miss changes that arrive during the
      //    initial scan.
      const pageToken = await this.drive.getStartPageToken();
      this.store.setPageToken(pageToken);

      // 2. List all files on Drive recursively
      const driveFiles = await this.drive.listAllFilesRecursive(rootFolderId);

      // 3. List all local vault files
      const localFiles = this.app.vault.getFiles();

      // 4. Build lookup maps
      const driveByName = new Map(
        driveFiles.map(({ file, folderPath }) => [
          folderPath ? `${folderPath}/${file.name}` : file.name,
          { file, folderPath },
        ])
      );
      const localByPath = new Map(localFiles.map((f) => [f.path, f]));

      // 5. Determine a folder map (driveId for each sub-folder path)
      const folderIdMap = new Map<string, string>();
      folderIdMap.set("", rootFolderId);
      for (const { file, folderPath } of driveFiles) {
        if (file.mimeType === "application/vnd.google-apps.folder") {
          const fullPath = folderPath ? `${folderPath}/${file.name}` : file.name;
          folderIdMap.set(fullPath, file.id);
        }
      }

      // 6. Drive-only files → download
      for (const [relativePath, { file }] of driveByName) {
        if (file.mimeType === "application/vnd.google-apps.folder") continue;
        if (file.mimeType.startsWith("application/vnd.google-apps.")) continue;

        if (!localByPath.has(relativePath)) {
          await this.downloadAndSave(
            file.id,
            relativePath,
            file.parents?.[0] ?? rootFolderId,
            new Date(file.modifiedTime).getTime(),
            file.md5Checksum ?? ""
          );
        }
      }

      // 7. Local-only files → upload
      for (const [localPath, tfile] of localByPath) {
        if (!this.shouldSync(localPath)) continue;
        if (!driveByName.has(localPath)) {
          const parentPath = localPath.includes("/")
            ? localPath.substring(0, localPath.lastIndexOf("/"))
            : "";
          const parentId = await this.ensureFolderPath(parentPath, folderIdMap);
          await this.uploadNew(localPath, tfile.stat.mtime, parentId);
        }
      }

      // 8. Both exist → last-write-wins
      for (const [relativePath, { file }] of driveByName) {
        if (file.mimeType.startsWith("application/vnd.google-apps.")) continue;
        if (!localByPath.has(relativePath)) continue;

        const localFile = localByPath.get(relativePath)!;
        const driveMtime = new Date(file.modifiedTime).getTime();
        const winner = this.resolver.resolve({
          localMtime: localFile.stat.mtime,
          driveMtime,
          syncedAt: 0, // no prior sync
        });

        const parentId = file.parents?.[0] ?? rootFolderId;

        if (winner === "remote") {
          await this.downloadAndSave(
            file.id,
            relativePath,
            parentId,
            driveMtime,
            file.md5Checksum ?? ""
          );
        } else {
          await this.uploadUpdate(relativePath, localFile.stat.mtime, file.id, parentId);
        }
      }

      await this.store.save();
      this.setStatus("idle");
    } catch (err) {
      this.setStatus("error", String(err));
      throw err;
    }
  }

  // ──────────────────────────────────────
  // Change operation handler (called by ChangeQueue)
  // ──────────────────────────────────────

  private async processOp(op: ChangeOp): Promise<void> {
    this.setStatus("syncing");
    try {
      switch (op.type) {
        case "upload":
          await this.handleUpload(op.localPath);
          break;
        case "download":
          await this.handleDownload(op.driveId, op.localPath);
          break;
        case "deleteLocal":
          await this.handleDeleteLocal(op.localPath);
          break;
        case "deleteRemote":
          await this.handleDeleteRemote(op.driveId);
          break;
        case "renameRemote":
          await this.handleRenameRemote(op);
          break;
      }
      this.store.removePendingUpload(op.type === "upload" ? op.localPath : "");
      await this.store.save();
      this.setStatus("idle");
    } catch (err) {
      console.error("[GDriveSync] processOp error:", err);
      if (this.isOfflineError(err)) {
        if (op.type === "upload") this.store.addPendingUpload(op.localPath);
        this.setStatus("offline");
      } else {
        this.setStatus("error", String(err));
      }
    }
  }

  private async handleUpload(localPath: string): Promise<void> {
    const tfile = this.app.vault.getFileByPath(localPath);
    const record = this.store.getRecord(localPath);

    // File was deleted locally
    if (!tfile) {
      if (record) {
        await this.drive.deleteFile(record.driveId);
        this.store.deleteRecord(localPath);
      }
      return;
    }

    const content = await this.app.vault.readBinary(tfile);
    const nowMs = tfile.stat.mtime;

    // Skip if mtime hasn't actually changed
    if (record && record.localMtime === nowMs) return;

    if (record) {
      // Check if it's a rename (path changed but we have a driveId)
      const updated = await this.drive.updateFile(record.driveId, content);
      this.store.setRecord({
        ...record,
        localMtime: nowMs,
        driveMtime: new Date(updated.modifiedTime).getTime(),
        driveMd5: updated.md5Checksum ?? "",
        syncedAt: Date.now(),
      });
    } else {
      // New file
      const parentPath = localPath.includes("/")
        ? localPath.substring(0, localPath.lastIndexOf("/"))
        : "";
      const parentId = await this.ensureFolderPath(
        parentPath,
        new Map([["", this.settings.folderId]])
      );
      await this.uploadNew(localPath, nowMs, parentId);
    }
  }

  private async handleDownload(driveId: string, localPath: string): Promise<void> {
    const record = this.store.getRecord(localPath);
    let driveFile;
    try {
      driveFile = await this.drive.getFile(driveId);
    } catch {
      // File was deleted on Drive
      if (record) {
        await this.deleteLocalFile(localPath);
        this.store.deleteRecord(localPath);
      }
      return;
    }

    const driveMtime = new Date(driveFile.modifiedTime).getTime();

    // Check content hash to skip unnecessary downloads
    if (record && record.driveMd5 === driveFile.md5Checksum) return;

    if (record) {
      const tfile = this.app.vault.getFileByPath(localPath);
      if (tfile) {
        const localMtime = tfile.stat.mtime;
        const winner = this.resolver.resolve({
          localMtime,
          driveMtime,
          syncedAt: record.syncedAt,
        });
        if (winner === "local") {
          // Re-upload local version
          await this.handleUpload(localPath);
          return;
        }
      }
    }

    await this.downloadAndSave(
      driveId,
      localPath,
      driveFile.parents?.[0] ?? this.settings.folderId,
      driveMtime,
      driveFile.md5Checksum ?? ""
    );
  }

  private async handleDeleteLocal(localPath: string): Promise<void> {
    await this.deleteLocalFile(localPath);
    this.store.deleteRecord(localPath);
  }

  private async handleDeleteRemote(driveId: string): Promise<void> {
    const record = this.store.getRecordByDriveId(driveId);
    if (!record) return;
    await this.drive.deleteFile(driveId);
    this.store.deleteRecord(record.localPath);
  }

  private async handleRenameRemote(op: Extract<ChangeOp, { type: "renameRemote" }>): Promise<void> {
    const record = this.store.getRecordByDriveId(op.driveId);
    if (!record) return;
    await this.drive.moveFile(op.driveId, op.newPath.split("/").pop()!, op.newParentId, op.oldParentId);
    this.store.renameRecord(op.oldPath, op.newPath);
  }

  // ──────────────────────────────────────
  // Low-level helpers
  // ──────────────────────────────────────

  private async uploadNew(localPath: string, mtime: number, parentId: string): Promise<void> {
    const tfile = this.app.vault.getFileByPath(localPath);
    if (!tfile) return;
    const content = await this.app.vault.readBinary(tfile);
    const name = localPath.split("/").pop()!;
    const created = await this.drive.createFile(name, parentId, content);
    this.store.setRecord({
      localPath,
      driveId: created.id,
      driveParentId: parentId,
      localMtime: mtime,
      driveMtime: new Date(created.modifiedTime).getTime(),
      driveMd5: created.md5Checksum ?? "",
      syncedAt: Date.now(),
    });
  }

  private async uploadUpdate(
    localPath: string,
    mtime: number,
    driveId: string,
    parentId: string
  ): Promise<void> {
    const tfile = this.app.vault.getFileByPath(localPath);
    if (!tfile) return;
    const content = await this.app.vault.readBinary(tfile);
    const updated = await this.drive.updateFile(driveId, content);
    this.store.setRecord({
      localPath,
      driveId,
      driveParentId: parentId,
      localMtime: mtime,
      driveMtime: new Date(updated.modifiedTime).getTime(),
      driveMd5: updated.md5Checksum ?? "",
      syncedAt: Date.now(),
    });
  }

  private async downloadAndSave(
    driveId: string,
    localPath: string,
    parentId: string,
    driveMtime: number,
    md5: string
  ): Promise<void> {
    const content = await this.drive.downloadFile(driveId);
    await this.ensureParentDir(localPath);

    const existing = this.app.vault.getFileByPath(localPath);
    if (existing) {
      await this.app.vault.modifyBinary(existing, content);
    } else {
      await this.app.vault.createBinary(localPath, content);
    }

    const tfile = this.app.vault.getFileByPath(localPath)!;
    this.store.setRecord({
      localPath,
      driveId,
      driveParentId: parentId,
      localMtime: tfile.stat.mtime,
      driveMtime,
      driveMd5: md5,
      syncedAt: Date.now(),
    });
  }

  private async deleteLocalFile(localPath: string): Promise<void> {
    const tfile = this.app.vault.getFileByPath(localPath);
    if (tfile) await this.app.vault.delete(tfile);
  }

  /**
   * Given a relative folder path (e.g. "notes/2024"), ensure all intermediate
   * Drive folders exist and return the Drive ID of the leaf folder.
   */
  private async ensureFolderPath(
    folderPath: string,
    cache: Map<string, string>
  ): Promise<string> {
    if (folderPath === "") return this.settings.folderId;

    const parts = folderPath.split("/");
    let currentId = this.settings.folderId;
    let built = "";

    for (const part of parts) {
      built = built ? `${built}/${part}` : part;
      if (cache.has(built)) {
        currentId = cache.get(built)!;
        continue;
      }
      // Find or create the folder on Drive
      const folders = await this.drive.listFolders(currentId);
      const existing = folders.find((f) => f.name === part);
      if (existing) {
        currentId = existing.id;
      } else {
        const created = await this.drive.createFolder(part, currentId);
        currentId = created.id;
      }
      cache.set(built, currentId);
    }

    return currentId;
  }

  private async ensureParentDir(localPath: string): Promise<void> {
    const parts = localPath.split("/");
    if (parts.length <= 1) return;
    const dir = parts.slice(0, -1).join("/");
    if (!this.app.vault.getFolderByPath(dir)) {
      await this.app.vault.createFolder(dir);
    }
  }

  private shouldSync(path: string): boolean {
    if (!this.settings.syncObsidianConfig && path.startsWith(".obsidian/")) return false;
    return true;
  }

  private isOfflineError(err: unknown): boolean {
    const msg = String(err).toLowerCase();
    return (
      msg.includes("failed to fetch") ||
      msg.includes("network") ||
      msg.includes("etimedout") ||
      msg.includes("enotfound")
    );
  }

  private setStatus(status: SyncStatus, error?: string): void {
    this._status = status;
    this._lastError = error ?? null;
    this.onStatusChange?.(status, error);
  }

  private async flushPendingUploads(): Promise<void> {
    for (const localPath of this.store.getPendingUploads()) {
      this.queue.enqueue({ type: "upload", localPath }, this.processOp.bind(this));
    }
  }
}
