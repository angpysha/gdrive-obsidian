import { App, Modal, Setting, Notice } from "obsidian";
import type { DriveClient } from "../drive/DriveClient";
import type { DriveFile } from "../types";

interface BreadcrumbItem {
  id: string;
  name: string;
}

/**
 * Modal that lets the user browse their Google Drive and select a folder.
 * Shows "My Drive" and "Shared with me" at the root level.
 */
export class FolderPickerModal extends Modal {
  private breadcrumbs: BreadcrumbItem[] = [];
  private items: DriveFile[] = [];
  private loading = false;

  onSelect: (folderId: string, folderName: string) => void = () => {};

  constructor(app: App, private drive: DriveClient) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText("Select a Google Drive folder");
    await this.loadRoot();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async loadRoot(): Promise<void> {
    this.breadcrumbs = [{ id: "root", name: "My Drive" }];
    this.items = [];
    this.render();

    try {
      const [myDrive, shared] = await Promise.all([
        this.drive.listFolders("root"),
        this.drive.listFolders("sharedWithMe"),
      ]);
      this.items = [...myDrive, ...shared];
    } catch (err) {
      new Notice(`Failed to list Drive folders: ${err}`);
    }
    this.render();
  }

  private async loadFolder(folderId: string, folderName: string): Promise<void> {
    this.breadcrumbs.push({ id: folderId, name: folderName });
    this.items = [];
    this.loading = true;
    this.render();

    try {
      this.items = await this.drive.listFolders(folderId);
    } catch (err) {
      new Notice(`Failed to list folder: ${err}`);
    }
    this.loading = false;
    this.render();
  }

  private async navigateTo(index: number): Promise<void> {
    const crumb = this.breadcrumbs[index];
    this.breadcrumbs = this.breadcrumbs.slice(0, index + 1);
    if (crumb.id === "root") {
      await this.loadRoot();
    } else {
      this.items = [];
      this.loading = true;
      this.render();
      this.items = await this.drive.listFolders(crumb.id);
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Breadcrumb trail
    const breadcrumbEl = contentEl.createDiv({ cls: "gdrive-breadcrumbs" });
    this.breadcrumbs.forEach((crumb, i) => {
      const span = breadcrumbEl.createSpan({ text: crumb.name, cls: "gdrive-crumb" });
      if (i < this.breadcrumbs.length - 1) {
        span.style.cursor = "pointer";
        span.style.textDecoration = "underline";
        span.addEventListener("click", () => this.navigateTo(i));
        breadcrumbEl.createSpan({ text: " / " });
      }
    });

    // "Select this folder" button for the current level
    const currentId = this.breadcrumbs[this.breadcrumbs.length - 1].id;
    const currentName = this.breadcrumbs[this.breadcrumbs.length - 1].name;
    if (currentId !== "root") {
      new Setting(contentEl)
        .setName("Use this folder as your vault")
        .addButton((btn) =>
          btn
            .setButtonText("Select")
            .setCta()
            .onClick(() => {
              this.onSelect(currentId, currentName);
              this.close();
            })
        );
    }

    contentEl.createEl("hr");

    if (this.loading) {
      contentEl.createEl("p", { text: "Loading…", cls: "gdrive-loading" });
      return;
    }

    if (this.items.length === 0) {
      contentEl.createEl("p", { text: "No sub-folders found.", cls: "gdrive-empty" });
      return;
    }

    const list = contentEl.createEl("ul", { cls: "gdrive-folder-list" });
    for (const folder of this.items) {
      const li = list.createEl("li", { cls: "gdrive-folder-item" });
      const icon = li.createSpan({ text: "📁 " });
      const name = li.createSpan({ text: folder.name });
      li.style.cursor = "pointer";
      li.addEventListener("click", () => this.loadFolder(folder.id, folder.name));
    }
  }
}
