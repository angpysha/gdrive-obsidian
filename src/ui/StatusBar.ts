import type { Plugin } from "obsidian";
import type { SyncStatus } from "../sync/SyncEngine";

const ICONS: Record<SyncStatus, string> = {
  idle: "☁ Synced",
  syncing: "↑↓ Syncing…",
  error: "✗ Sync error",
  offline: "⚡ Offline",
};

export class StatusBar {
  private el: HTMLElement;

  constructor(plugin: Plugin) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass("gdrive-sync-status");
    this.update("idle");
  }

  update(status: SyncStatus, error?: string): void {
    this.el.setText(ICONS[status]);
    this.el.title = error ?? "";
    this.el.toggleClass("gdrive-sync-error", status === "error");
    this.el.toggleClass("gdrive-sync-offline", status === "offline");
    this.el.toggleClass("gdrive-sync-syncing", status === "syncing");
  }

  hide(): void {
    this.el.style.display = "none";
  }

  show(): void {
    this.el.style.display = "";
  }
}
