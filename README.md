# GDrive Sync for Obsidian

Bidirectional sync between your Obsidian vault and a Google Drive folder. Supports shared folders — use a folder shared by another user as a collaborative vault.

## Features

- **Bidirectional sync** — changes flow both ways, last-write-wins on conflict
- **Shared Drive folders** — use a folder owned by someone else as your vault
- **Sync on save** — files upload immediately when you save
- **Background polling** — picks up remote changes every N minutes
- **All file types** — markdown, images, PDFs, canvas files, attachments
- **Offline support** — queues changes and flushes when connectivity returns
- **Desktop + Mobile** — works on macOS, Windows, Linux, iOS, and Android

## Installation

### Via BRAT (recommended for beta testing)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian Community Plugins
2. Open BRAT settings → **Add Beta Plugin**
3. Paste: `https://github.com/angpysha/gdrive-obsidian`
4. Enable **GDrive Sync (custom)** in Community Plugins

### Manual

1. Download `gdrive-sync.zip` from the [latest release](https://github.com/angpysha/gdrive-obsidian/releases/latest)
2. Unzip into `<your-vault>/.obsidian/plugins/gdrive-sync/`
3. Reload Obsidian → Settings → Community plugins → enable **GDrive Sync (custom)**

## Setup

### 1. Google Cloud credentials

You need an OAuth 2.0 Client ID from Google Cloud Console:

1. Go to [Google Cloud Console](https://console.cloud.google.com) → create a project
2. Enable the **Google Drive API**
3. Go to **APIs & Services → OAuth consent screen** → set up (External, Testing mode)
4. Add your Google email(s) under **Test users**
5. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
6. Application type: **Desktop app** → Create
7. Copy the **Client ID** and **Client Secret**

### 2. Connect in Obsidian

1. Open plugin settings → paste **Client ID** and **Client Secret**
2. Click **Connect Google Account** → approve in browser
3. Click **Select folder** → browse and select your Drive folder
4. Initial sync runs automatically

## Settings

| Setting | Default | Description |
|---|---|---|
| Poll interval | 2 min | How often to check Drive for remote changes |
| Sync on save | On | Upload immediately when a file is saved |
| Sync .obsidian/ | Off | Include Obsidian config files in sync |
| Excluded paths | workspace.json | Glob patterns to skip |
| Status bar | On | Show sync status in the bottom bar |

## Notes

- **Google Docs / Sheets / Slides** are skipped — they have no binary representation
- The `.obsidian/` config folder is excluded by default (recommended for shared vaults)
- The OAuth app stays in **Testing mode** — each user must be added as a test user in Cloud Console

## License

MIT
