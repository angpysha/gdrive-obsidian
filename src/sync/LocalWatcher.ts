import type { App, TFile, TAbstractFile } from "obsidian";
import type { ChangeQueue } from "./ChangeQueue";
import type { GDriveSyncSettings } from "../types";
import { minimatch } from "../util/minimatch";

/**
 * Listens to Obsidian Vault events and enqueues upload/delete/rename
 * operations whenever the user modifies files locally.
 */
export class LocalWatcher {
  private handlers: (() => void)[] = [];

  constructor(
    private app: App,
    private settings: GDriveSyncSettings,
    private queue: ChangeQueue,
    private handleOp: ChangeQueue["enqueue"] extends (op: infer O, h: infer H) => void
      ? (op: O) => Promise<void>
      : never
  ) {}

  start(): void {
    const { vault } = this.app;

    const onModify = (file: TAbstractFile) => {
      if (!this.settings.syncOnSave) return;
      if (!(file instanceof this.app.vault.adapter.constructor)) {
        // file is TFile
      }
      const tfile = file as TFile;
      if (!this.shouldSync(tfile.path)) return;
      this.queue.enqueue({ type: "upload", localPath: tfile.path }, this.handleOp);
    };

    const onCreate = (file: TAbstractFile) => {
      const tfile = file as TFile;
      if (tfile.extension === undefined) return; // folder
      if (!this.shouldSync(tfile.path)) return;
      this.queue.enqueue({ type: "upload", localPath: tfile.path }, this.handleOp);
    };

    const onDelete = (file: TAbstractFile) => {
      if (!this.shouldSync(file.path)) return;
      // SyncEngine will look up driveId from StateStore
      this.queue.enqueue({ type: "upload", localPath: file.path }, this.handleOp);
    };

    const onRename = (file: TAbstractFile, oldPath: string) => {
      if (!this.shouldSync(file.path) && !this.shouldSync(oldPath)) return;
      // We model rename as a special upload (SyncEngine checks if driveId exists
      // and issues a metadata-only PATCH instead of re-uploading content).
      this.queue.enqueue({ type: "upload", localPath: file.path }, this.handleOp);
    };

    vault.on("modify", onModify);
    vault.on("create", onCreate);
    vault.on("delete", onDelete);
    vault.on("rename", onRename);

    this.handlers.push(
      () => vault.off("modify", onModify),
      () => vault.off("create", onCreate),
      () => vault.off("delete", onDelete),
      () => vault.off("rename", onRename)
    );
  }

  stop(): void {
    this.handlers.forEach((h) => h());
    this.handlers = [];
  }

  private shouldSync(path: string): boolean {
    if (!this.settings.syncObsidianConfig && path.startsWith(".obsidian/")) {
      return false;
    }
    for (const pattern of this.settings.excludePatterns) {
      if (minimatch(path, pattern)) return false;
    }
    return true;
  }
}
