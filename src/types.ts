// ────────────────────────────────────────────────────
// Auth types
// ────────────────────────────────────────────────────

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expiry_date: number; // ms epoch
}

// ────────────────────────────────────────────────────
// Plugin settings (persisted via Obsidian's saveData)
// ────────────────────────────────────────────────────

export interface GDriveSyncSettings {
  /** Google OAuth2 client id (from Cloud Console) */
  clientId: string;
  /** Google OAuth2 client secret */
  clientSecret: string;
  /** Stored OAuth2 tokens */
  tokens: TokenSet | null;
  /** Drive file ID of the selected root folder */
  folderId: string;
  /** Human-readable name of the selected folder (display only) */
  folderName: string;
  /** Remote polling interval in minutes */
  pollIntervalMin: number;
  /** Whether to sync the .obsidian/ config directory */
  syncObsidianConfig: boolean;
  /** Glob patterns to exclude from sync */
  excludePatterns: string[];
  /** Whether to sync on every file save */
  syncOnSave: boolean;
  /** Whether to show status in the status bar */
  showStatusBar: boolean;
}

export const DEFAULT_SETTINGS: GDriveSyncSettings = {
  clientId: "",
  clientSecret: "",
  tokens: null,
  folderId: "",
  folderName: "",
  pollIntervalMin: 2,
  syncObsidianConfig: false,
  excludePatterns: [".obsidian/workspace.json", ".obsidian/workspace-mobile.json"],
  syncOnSave: true,
  showStatusBar: true,
};

// ────────────────────────────────────────────────────
// State store types (persisted separately in state.json)
// ────────────────────────────────────────────────────

export interface FileRecord {
  /** Path relative to vault root */
  localPath: string;
  /** Drive file ID */
  driveId: string;
  /** Drive parent folder ID */
  driveParentId: string;
  /** Last known local mtime (ms epoch) */
  localMtime: number;
  /** Drive modifiedTime as ms epoch */
  driveMtime: number;
  /** Drive md5Checksum (used to skip unnecessary downloads) */
  driveMd5: string;
  /** Timestamp of last successful sync (ms epoch) */
  syncedAt: number;
}

export interface SyncState {
  fileRecords: Record<string, FileRecord>; // keyed by localPath
  driveChangesPageToken: string;
  pendingUploads: string[]; // localPaths queued while offline
}

// ────────────────────────────────────────────────────
// Drive API types (subset we actually use)
// ────────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime: string; // RFC 3339
  md5Checksum?: string;
  trashed?: boolean;
  size?: string;
}

export interface DriveChange {
  type: "file" | "drive";
  fileId?: string;
  file?: DriveFile;
  removed?: boolean;
}
