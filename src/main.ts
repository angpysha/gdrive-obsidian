import { Plugin, Notice } from "obsidian";
import { AuthService } from "./auth/AuthService";
import { DriveClient } from "./drive/DriveClient";
import { SyncEngine } from "./sync/SyncEngine";
import { StateStore } from "./store/StateStore";
import { SettingsTab } from "./ui/SettingsTab";
import { StatusBar } from "./ui/StatusBar";
import { DEFAULT_SETTINGS, type GDriveSyncSettings } from "./types";

export default class GDriveSyncPlugin extends Plugin {
  settings: GDriveSyncSettings = DEFAULT_SETTINGS;

  auth: AuthService | null = null;
  drive: DriveClient | null = null;
  syncEngine: SyncEngine | null = null;
  statusBar: StatusBar | null = null;

  private store: StateStore | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new SettingsTab(this.app, this));

    // Status bar (may be hidden per settings)
    this.statusBar = new StatusBar(this);
    if (!this.settings.showStatusBar) this.statusBar.hide();

    // Boot auth + sync if already configured
    if (this.settings.clientId && this.settings.clientSecret) {
      this.initAuth();
    }

    if (this.auth?.isAuthenticated() && this.settings.folderId) {
      await this.startSync(false);
    }

    // Handle OAuth2 redirect via obsidian:// protocol (desktop + mobile)
    this.registerObsidianProtocolHandler("gdrive-callback", (params) => {
      this.auth?.handleCallback(params).catch((err) => {
        new Notice(`Google auth error: ${err}`);
      });
    });

    // Command: manual sync
    this.addCommand({
      id: "gdrive-sync-now",
      name: "Sync with Google Drive now",
      callback: async () => {
        if (!this.syncEngine) {
          new Notice("Google Drive Sync: not configured yet.");
          return;
        }
        try {
          await this.syncEngine.initialSync();
          new Notice("Google Drive Sync: complete!");
        } catch (err) {
          new Notice(`Google Drive Sync failed: ${err}`);
        }
      },
    });
  }

  onunload(): void {
    this.syncEngine?.stop();
  }

  // ──────────────────────────────────────
  // Called from SettingsTab / bootstrap
  // ──────────────────────────────────────

  initAuth(): void {
    this.auth = new AuthService(
      this.settings.clientId,
      this.settings.clientSecret,
      this.settings.tokens,
      async (tokens) => {
        this.settings.tokens = tokens;
        await this.saveSettings();
      }
    );
    this.drive = new DriveClient(this.auth);
  }

  /**
   * Start (or restart) the sync engine.
   * @param initialSync  If true, run a full initial reconciliation first.
   */
  async startSync(initialSync: boolean): Promise<void> {
    this.syncEngine?.stop();

    if (!this.auth || !this.drive || !this.settings.folderId) return;

    this.store = new StateStore(this.app);
    await this.store.load();

    this.syncEngine = new SyncEngine(this.app, this.drive, this.store, this.settings);
    this.syncEngine.onStatusChange = (status, error) => {
      this.statusBar?.update(status, error);
    };

    if (initialSync) {
      await this.syncEngine.initialSync();
    }

    this.syncEngine.start();
  }

  // ──────────────────────────────────────
  // Settings persistence
  // ──────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
