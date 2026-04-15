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

---

## Installation

### Via BRAT (recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian Community Plugins
2. Open BRAT settings → **Add Beta Plugin**
3. Enter: `angpysha/gdrive-obsidian`
4. Enable **GDrive Sync (custom)** in Community Plugins

### Manual

1. Download `gdrive-sync.zip` from the [latest release](https://github.com/angpysha/gdrive-obsidian/releases/latest)
2. Unzip into `<your-vault>/.obsidian/plugins/gdrive-sync/`
3. Reload Obsidian → Settings → Community plugins → enable **GDrive Sync (custom)**

---

## Setup: Google credentials (required)

Each user needs their own free Google Cloud credentials. This takes about 5 minutes, is completely free, requires no billing setup, and works with any existing Google account.

### Step 1 — Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with your Google account
2. Click the project dropdown at the top → **New Project**
3. Give it any name (e.g. `Obsidian Sync`) → **Create**
4. If prompted about billing — skip it, no billing is needed for this plugin

### Step 2 — Enable the Drive API

1. In the left sidebar go to **APIs & Services → Library**
2. Search for **Google Drive API** → click it → **Enable**

### Step 3 — Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**
2. User Type: **External** → **Create**
3. Fill in:
   - App name: anything (e.g. `Obsidian Sync`)
   - User support email: your email
   - Developer contact email: your email
4. Click **Save and Continue** through all steps (no need to add scopes or test users)
5. On the final summary page click **Back to Dashboard**

> You do **not** need to publish the app or add test users — you are the developer, so your own account always has access.

### Step 4 — Create OAuth credentials

1. Go to **APIs & Services → Credentials**
2. Click **+ Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name: anything (e.g. `Obsidian Plugin`)
5. Under **Authorized redirect URIs** click **+ Add URI** and enter:
   ```
   https://angpysha.github.io/gdrive-obsidian/callback
   ```
6. Click **Create**
7. Copy the **Client ID** and **Client Secret** shown in the dialog

### Step 5 — Connect in Obsidian

1. Open plugin settings → paste your **Client ID** and **Client Secret**
2. Click **Connect Google Account** → your browser opens Google sign-in
3. Sign in with your Google account → **Allow**
4. Obsidian reopens automatically and shows "Connected"
5. Click **Select folder** → browse your Drive → pick a folder → **Select**
6. Initial sync runs and your vault is connected

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Poll interval | 2 min | How often to check Drive for remote changes |
| Sync on save | On | Upload immediately when a file is saved |
| Sync .obsidian/ | Off | Include Obsidian config files in sync |
| Excluded paths | workspace.json | Glob patterns to skip |
| Status bar | On | Show sync status in the bottom bar |

---

## Notes

- **Google Docs / Sheets / Slides** are skipped — they have no local file representation
- The `.obsidian/` config folder is excluded by default (recommended for shared vaults)
- Shared Drive folders are fully supported — select any folder shared with your account

## License

MIT
