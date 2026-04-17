import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { AuthService } from "../auth/AuthService";
import { log } from "../util/Logger";
import type { DriveChange, DriveFile } from "../types";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

/** Fields requested for every file listing to keep response payloads small. */
const FILE_FIELDS =
  "id,name,mimeType,parents,modifiedTime,md5Checksum,trashed,size";

/**
 * Thin, typed wrapper around the Drive API v3.
 * Every method transparently refreshes the access token via AuthService.
 */
export class DriveClient {
  constructor(private auth: AuthService) {}

  // ──────────────────────────────────────
  // Folder browsing
  // ──────────────────────────────────────

  /** List sub-folders inside a parent (use 'root' or 'sharedWithMe' as parentId). */
  async listFolders(parentId: string): Promise<DriveFile[]> {
    const q =
      parentId === "sharedWithMe"
        ? `mimeType='application/vnd.google-apps.folder' and sharedWithMe=true and trashed=false`
        : `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;

    return this.listAll(q, FILE_FIELDS);
  }

  /** List all files (non-folders) directly inside a folder. */
  async listFiles(folderId: string): Promise<DriveFile[]> {
    const q = `'${folderId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`;
    return this.listAll(q, FILE_FIELDS);
  }

  /**
   * Recursively list every file under a folder, returning a flat array.
   * Also returns a map of driveId → folderPath for directory reconstruction.
   */
  async listAllFilesRecursive(
    rootFolderId: string
  ): Promise<{ file: DriveFile; folderPath: string }[]> {
    const results: { file: DriveFile; folderPath: string }[] = [];
    await this.recurse(rootFolderId, "", results);
    return results;
  }

  private async recurse(
    folderId: string,
    currentPath: string,
    acc: { file: DriveFile; folderPath: string }[]
  ): Promise<void> {
    const [folders, files] = await Promise.all([
      this.listFolders(folderId),
      this.listFiles(folderId),
    ]);

    for (const f of files) {
      acc.push({ file: f, folderPath: currentPath });
    }

    await Promise.all(
      folders.map((folder) =>
        this.recurse(
          folder.id,
          currentPath ? `${currentPath}/${folder.name}` : folder.name,
          acc
        )
      )
    );
  }

  // ──────────────────────────────────────
  // File CRUD
  // ──────────────────────────────────────

  /** Download file content as an ArrayBuffer. */
  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const resp = await this.fetch(`${API}/files/${fileId}?alt=media`);
    return await resp.arrayBuffer();
  }

  /** Upload a new file. Returns the created DriveFile. */
  async createFile(
    name: string,
    parentId: string,
    content: ArrayBuffer,
    mimeType = "application/octet-stream"
  ): Promise<DriveFile> {
    const metadata = { name, parents: [parentId] };
    return this.multipartUpload("POST", null, metadata, content, mimeType);
  }

  /** Upload a new folder. Returns the created DriveFile. */
  async createFolder(name: string, parentId: string): Promise<DriveFile> {
    const body = JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    });
    const resp = await this.fetch(`${API}/files?fields=${FILE_FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return await resp.json() as DriveFile;
  }

  /**
   * Update file content (and optionally rename).
   * Uses a resumable session for files > 5 MB.
   */
  async updateFile(
    fileId: string,
    content: ArrayBuffer,
    mimeType = "application/octet-stream",
    newName?: string
  ): Promise<DriveFile> {
    const metadata: Record<string, string> = {};
    if (newName) metadata.name = newName;

    if (content.byteLength > 5 * 1024 * 1024) {
      return this.resumableUpload(fileId, metadata, content, mimeType);
    }
    return this.multipartUpload("PATCH", fileId, metadata, content, mimeType);
  }

  /** Rename or move a file without re-uploading content. */
  async moveFile(
    fileId: string,
    newName: string,
    newParentId: string,
    oldParentId: string
  ): Promise<DriveFile> {
    const params = new URLSearchParams({
      addParents: newParentId,
      removeParents: oldParentId,
      fields: FILE_FIELDS,
    });
    const resp = await this.fetch(
      `${API}/files/${fileId}?${params}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      }
    );
    return await resp.json() as DriveFile;
  }

  /** Permanently delete a file. */
  async deleteFile(fileId: string): Promise<void> {
    await this.fetch(`${API}/files/${fileId}`, { method: "DELETE" });
  }

  /** Get file metadata. */
  async getFile(fileId: string): Promise<DriveFile> {
    const resp = await this.fetch(`${API}/files/${fileId}?fields=${FILE_FIELDS}`);
    return await resp.json() as DriveFile;
  }

  // ──────────────────────────────────────
  // Changes API (delta sync)
  // ──────────────────────────────────────

  /** Get a page token representing "now" — use this on initial connect. */
  async getStartPageToken(): Promise<string> {
    const resp = await this.fetch(`${API}/changes/getStartPageToken`);
    const data = await resp.json() as { startPageToken: string };
    return data.startPageToken;
  }

  /**
   * Fetch changes since the given pageToken.
   * Returns changes and the next pageToken to store.
   */
  async listChanges(
    pageToken: string
  ): Promise<{ changes: DriveChange[]; newPageToken: string }> {
    const changes: DriveChange[] = [];
    let token = pageToken;

    while (true) {
      const params = new URLSearchParams({
        pageToken: token,
        fields: `nextPageToken,newStartPageToken,changes(type,fileId,removed,file(${FILE_FIELDS}))`,
        pageSize: "200",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
      });
      const resp = await this.fetch(`${API}/changes?${params}`);
      const data = await resp.json() as {
        changes?: DriveChange[];
        newStartPageToken?: string;
        nextPageToken?: string;
      };

      changes.push(...(data.changes ?? []));

      if (data.newStartPageToken) {
        return { changes, newPageToken: data.newStartPageToken };
      }
      token = data.nextPageToken!;
    }
  }

  // ──────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────

  private async listAll(q: string, fields: string): Promise<DriveFile[]> {
    const results: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${fields})`,
        pageSize: "200",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      const resp = await this.fetch(`${API}/files?${params}`);
      const data = await resp.json() as { files?: DriveFile[]; nextPageToken?: string };
      results.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);

    return results;
  }

  /** Multipart upload for files ≤ 5 MB. */
  private async multipartUpload(
    method: "POST" | "PATCH",
    fileId: string | null,
    metadata: Record<string, unknown>,
    content: ArrayBuffer,
    mimeType: string
  ): Promise<DriveFile> {
    const boundary = `boundary_${Math.random().toString(36).slice(2)}`;
    const metaPart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n`;
    const dataPart =
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const closing = `\r\n--${boundary}--`;

    const metaBytes = new TextEncoder().encode(metaPart);
    const dataHeaderBytes = new TextEncoder().encode(dataPart);
    const closingBytes = new TextEncoder().encode(closing);

    const body = new Uint8Array(
      metaBytes.byteLength +
        dataHeaderBytes.byteLength +
        content.byteLength +
        closingBytes.byteLength
    );
    let offset = 0;
    body.set(metaBytes, offset); offset += metaBytes.byteLength;
    body.set(dataHeaderBytes, offset); offset += dataHeaderBytes.byteLength;
    body.set(new Uint8Array(content), offset); offset += content.byteLength;
    body.set(closingBytes, offset);

    const url = fileId
      ? `${UPLOAD_API}/files/${fileId}?uploadType=multipart&fields=${FILE_FIELDS}&supportsAllDrives=true`
      : `${UPLOAD_API}/files?uploadType=multipart&fields=${FILE_FIELDS}&supportsAllDrives=true`;

    const resp = await this.fetch(url, {
      method,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: body.buffer as ArrayBuffer,
    });
    return resp.json() as Promise<DriveFile>;
  }

  /** Resumable upload for files > 5 MB. */
  private async resumableUpload(
    fileId: string,
    metadata: Record<string, unknown>,
    content: ArrayBuffer,
    mimeType: string
  ): Promise<DriveFile> {
    const initResp = await this.fetch(
      `${UPLOAD_API}/files/${fileId}?uploadType=resumable&fields=${FILE_FIELDS}&supportsAllDrives=true`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Upload-Content-Type": mimeType,
          "X-Upload-Content-Length": String(content.byteLength),
        },
        body: JSON.stringify(metadata),
      }
    );
    const sessionUri = initResp.headers.get("location");
    if (!sessionUri) throw new Error("No resumable upload session URI");

    const uploadResp = await requestUrl({
      url: sessionUri,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${await this.auth.getAccessToken()}`,
        "Content-Type": mimeType,
        "Content-Length": String(content.byteLength),
      },
      body: content,
      throw: false,
    });
    if (uploadResp.status >= 400)
      throw new Error(`Resumable upload failed: ${uploadResp.status}`);
    return uploadResp.json as DriveFile;
  }

  /**
   * Authenticated request via Obsidian's requestUrl (routes through the main
   * process — avoids CORS / CSP restrictions that block window.fetch in the
   * renderer).  Returns a thin wrapper that exposes .json(), .arrayBuffer(),
   * .text(), and .headers.get() so callers don't need to change.
   */
  private async fetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: ArrayBuffer | string } = {}
  ): Promise<{
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
    headers: { get(name: string): string | null };
  }> {
    const token = await this.auth.getAccessToken();
    const method = init.method ?? "GET";
    const shortUrl = url.replace("https://www.googleapis.com", "").replace("https://www.googleapis.com/upload", "");
    log("info", `Drive ${method} ${shortUrl} | sending Authorization: Bearer ${token.substring(0, 12)}…`);
    const resp: RequestUrlResponse = await requestUrl({
      url,
      method,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      body: init.body,
      throw: false,
    });

    log(resp.status >= 400 ? "error" : "info", `Drive response: ${resp.status} for ${shortUrl}`);
    if (resp.status >= 400) {
      throw new Error(`Drive API ${resp.status}: ${resp.text}`);
    }

    return {
      json: () => Promise.resolve(resp.json),
      arrayBuffer: () => Promise.resolve(resp.arrayBuffer),
      text: () => Promise.resolve(resp.text),
      headers: {
        get: (name: string) =>
          (resp.headers as Record<string, string>)[name.toLowerCase()] ?? null,
      },
    };
  }
}
