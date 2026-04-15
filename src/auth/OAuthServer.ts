/**
 * Temporary loopback HTTP server used only on desktop (Electron/Node.js).
 * Listens on a random port, receives the OAuth2 redirect, captures the code,
 * and immediately responds with a close-me page.
 *
 * This file must NOT be imported at the top level on mobile — AuthService
 * imports it lazily with `await import('./OAuthServer')`.
 */
import * as http from "http";
import * as net from "net";

export class OAuthServer {
  private server: http.Server | null = null;
  private port = 0;

  async start(): Promise<{ port: number }> {
    this.port = await this.findFreePort();

    return new Promise((resolve, reject) => {
      this.server = http.createServer();
      this.server.listen(this.port, "127.0.0.1", () => {
        resolve({ port: this.port });
      });
      this.server.on("error", reject);
    });
  }

  /** Returns a Promise that resolves with the authorization code. */
  waitForCode(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error("Server not started"));
        return;
      }

      this.server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end();
          return;
        }

        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(this.htmlPage("Error", `Authorization failed: ${error}`));
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(this.htmlPage("Error", "No authorization code received."));
          reject(new Error("No code in callback"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          this.htmlPage(
            "Success",
            "Authorization successful! You can close this tab and return to Obsidian."
          )
        );
        resolve(code);
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close(() => resolve(addr.port));
      });
      srv.on("error", reject);
    });
  }

  private htmlPage(title: string, message: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <title>${title} — Obsidian Google Drive Sync</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; border-radius: 12px; padding: 2rem 3rem;
            box-shadow: 0 2px 16px rgba(0,0,0,.1); text-align: center; max-width: 420px; }
    h1 { font-size: 1.4rem; margin-bottom: .5rem; }
    p  { color: #555; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
  }
}
