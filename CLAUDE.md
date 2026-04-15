# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run dev          # watch mode (esbuild, outputs main.js)
npm run build        # type-check + production build
npm test             # run Vitest unit tests
npm run test:watch   # Vitest in watch mode
```

To test the plugin in Obsidian: copy `main.js` and `manifest.json` into your vault's `.obsidian/plugins/gdrive-sync/` directory, then enable it in Obsidian's Community Plugins settings.

## Architecture

The plugin is built as a standard Obsidian community plugin (TypeScript → esbuild → single `main.js` CJS bundle). There is no backend — all communication is directly between the client and Google's APIs.

### Entry point

`src/main.ts` — `GDriveSyncPlugin` extends Obsidian's `Plugin`. It owns all service instances and wires them together at load time. Key lifecycle:

1. `onload`: restore settings → `initAuth()` → if already configured, `startSync(false)` → register mobile protocol handler.
2. `startSync(initialSync)`: creates a fresh `SyncEngine`, optionally runs `initialSync()` for first-connect reconciliation, then calls `start()` to begin watching + polling.
3. `onunload`: calls `syncEngine.stop()`.

### Service layer

| File | Responsibility |
|---|---|
| `src/auth/AuthService.ts` | OAuth2 token lifecycle. Desktop uses a loopback HTTP server (`OAuthServer`); mobile uses the `obsidian://gdrive-callback` URI scheme. Token refresh is transparent — every Drive call goes through `getAccessToken()`. |
| `src/auth/OAuthServer.ts` | Node.js `http.Server` that captures the authorization code. **Desktop-only** — imported lazily so mobile doesn't load it. |
| `src/drive/DriveClient.ts` | Typed wrapper over Drive API v3. All requests are authenticated via `AuthService`. Handles multipart uploads (≤5 MB) and resumable uploads (>5 MB). Uses the Changes API for delta polling. |
| `src/store/StateStore.ts` | Persists the file↔DriveId mapping and the Changes API page token to `.obsidian/plugins/gdrive-sync/state.json` via Obsidian's `vault.adapter`. |
| `src/sync/SyncEngine.ts` | Orchestrates everything. Owns `ChangeQueue`, `LocalWatcher`, and `RemotePoller`. `initialSync()` does the first full two-way reconciliation. `processOp()` handles individual change operations. |
| `src/sync/LocalWatcher.ts` | Subscribes to Obsidian's `vault.on('modify'/'create'/'delete'/'rename')` events and enqueues upload ops. |
| `src/sync/RemotePoller.ts` | Calls `DriveClient.listChanges()` on an interval and enqueues download/deleteLocal ops. |
| `src/sync/ChangeQueue.ts` | Serialised async queue — ensures ops run one at a time to prevent races. |
| `src/sync/ConflictResolver.ts` | Last-write-wins: compares `localMtime` vs `driveMtime` relative to `syncedAt`. |
| `src/util/minimatch.ts` | Minimal glob matcher for the exclude-patterns feature (`*` and `**` only). |

### UI

| File | Responsibility |
|---|---|
| `src/ui/SettingsTab.ts` | Obsidian settings panel. References `plugin.auth`, `plugin.drive`, `plugin.syncEngine` directly. |
| `src/ui/FolderPickerModal.ts` | Breadcrumb-based Drive folder browser modal. Calls `DriveClient.listFolders()`. |
| `src/ui/StatusBar.ts` | Status bar item showing idle / syncing / error / offline state. |

### State model

`FileRecord` (in `types.ts`) maps each local file path to its Drive ID and stores both mtimes (`localMtime`, `driveMtime`) plus `syncedAt` — the timestamp of the last successful sync. This three-timestamp model is how `ConflictResolver` determines whether a conflict is real and which side wins.

### Key invariants

- **No re-upload when mtime hasn't changed**: `SyncEngine.handleUpload` exits early if `record.localMtime === tfile.stat.mtime`.
- **md5 check skips redundant downloads**: `handleDownload` skips content fetch if `record.driveMd5 === driveFile.md5Checksum`.
- **Offline queue**: if a Drive call fails with a network error, the local path is added to `StateStore.pendingUploads` and flushed on next `start()`.
- **Google-native file types** (`application/vnd.google-apps.*`) are silently skipped — they have no binary representation.
- **`.obsidian/`** is excluded from sync by default (configurable).

## Setup: Google Cloud credentials

Users must create an OAuth 2.0 Client ID in the Google Cloud Console (application type: **Desktop app**) and add the Drive scope (`https://www.googleapis.com/auth/drive`). The Client ID and Secret are entered in the plugin's settings tab.
