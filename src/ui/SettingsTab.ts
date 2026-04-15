import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type GDriveSyncPlugin from "../main";
import { FolderPickerModal } from "./FolderPickerModal";

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: GDriveSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl, plugin } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Google Drive Sync" });

    // ── OAuth credentials ──────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Google Cloud credentials" });
    containerEl.createEl("p", {
      text: "Create an OAuth 2.0 Client ID in Google Cloud Console (type: Desktop app), then paste the values below.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Client ID")
      .addText((text) =>
        text
          .setPlaceholder("*.apps.googleusercontent.com")
          .setValue(plugin.settings.clientId)
          .onChange(async (v) => {
            plugin.settings.clientId = v.trim();
            await plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Client Secret")
      .addText((text) =>
        text
          .setPlaceholder("GOCSPX-…")
          .setValue(plugin.settings.clientSecret)
          .onChange(async (v) => {
            plugin.settings.clientSecret = v.trim();
            await plugin.saveSettings();
          })
      );

    // ── Account connection ─────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Account" });

    if (plugin.auth?.isAuthenticated()) {
      new Setting(containerEl)
        .setName("Connected")
        .setDesc("Your Google account is connected.")
        .addButton((btn) =>
          btn.setButtonText("Disconnect").onClick(async () => {
            await plugin.auth!.logout();
            await plugin.saveSettings();
            this.display();
          })
        );
    } else {
      new Setting(containerEl)
        .setName("Not connected")
        .setDesc("Connect your Google account to enable sync.")
        .addButton((btn) =>
          btn
            .setButtonText("Connect Google Account")
            .setCta()
            .onClick(async () => {
              if (!plugin.settings.clientId || !plugin.settings.clientSecret) {
                new Notice("Please enter your Client ID and Client Secret first.");
                return;
              }
              try {
                if (!plugin.auth) plugin.initAuth();
                await plugin.auth!.login();
                await plugin.saveSettings();
                this.display();
                new Notice("Google account connected!");
              } catch (err) {
                new Notice(`Connection failed: ${err}`);
              }
            })
        );
    }

    // ── Drive folder ───────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Sync folder" });

    const folderDesc = plugin.settings.folderName
      ? `Currently syncing: ${plugin.settings.folderName}`
      : "No folder selected.";

    new Setting(containerEl)
      .setName("Google Drive folder")
      .setDesc(folderDesc)
      .addButton((btn) =>
        btn
          .setButtonText(plugin.settings.folderId ? "Change folder" : "Select folder")
          .onClick(async () => {
            if (!plugin.auth?.isAuthenticated()) {
              new Notice("Connect your Google account first.");
              return;
            }
            if (!plugin.drive) plugin.initAuth();
            const modal = new FolderPickerModal(this.app, plugin.drive!);
            modal.onSelect = async (id, name) => {
              plugin.settings.folderId = id;
              plugin.settings.folderName = name;
              await plugin.saveSettings();
              this.display(); // always refresh UI to show selected folder
              try {
                new Notice(`Starting initial sync with "${name}"…`);
                await plugin.startSync(true);
                new Notice(`Sync complete!`);
              } catch (err) {
                console.error("[GDriveSync] Initial sync error:", err);
                new Notice(`Sync error: ${err}`, 8000);
              }
            };
            modal.open();
          })
      );

    // ── Sync behaviour ─────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Behaviour" });

    new Setting(containerEl)
      .setName("Poll interval (minutes)")
      .setDesc("How often to check Drive for remote changes.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 60, 1)
          .setValue(plugin.settings.pollIntervalMin)
          .setDynamicTooltip()
          .onChange(async (v) => {
            plugin.settings.pollIntervalMin = v;
            await plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync on save")
      .setDesc("Upload files immediately when you save them.")
      .addToggle((t) =>
        t.setValue(plugin.settings.syncOnSave).onChange(async (v) => {
          plugin.settings.syncOnSave = v;
          await plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync .obsidian/ config folder")
      .setDesc("Include Obsidian's configuration files in the sync (not recommended for shared vaults).")
      .addToggle((t) =>
        t.setValue(plugin.settings.syncObsidianConfig).onChange(async (v) => {
          plugin.settings.syncObsidianConfig = v;
          await plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show status in status bar")
      .addToggle((t) =>
        t.setValue(plugin.settings.showStatusBar).onChange(async (v) => {
          plugin.settings.showStatusBar = v;
          await plugin.saveSettings();
          if (v) plugin.statusBar?.show();
          else plugin.statusBar?.hide();
        })
      );

    // ── Exclude patterns ───────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Excluded paths (one glob per line)" });

    new Setting(containerEl).addTextArea((ta) =>
      ta
        .setValue(plugin.settings.excludePatterns.join("\n"))
        .onChange(async (v) => {
          plugin.settings.excludePatterns = v
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
          await plugin.saveSettings();
        })
    );

    // ── Manual sync ────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Manually trigger a full sync cycle.")
      .addButton((btn) =>
        btn.setButtonText("Sync now").onClick(async () => {
          if (!plugin.syncEngine) {
            new Notice("Configure your account and folder first.");
            return;
          }
          try {
            await plugin.syncEngine.initialSync();
            new Notice("Sync complete!");
          } catch (err) {
            new Notice(`Sync failed: ${err}`);
          }
        })
      );
  }
}
