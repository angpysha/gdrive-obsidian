import { Platform } from "obsidian";
import type { GDriveSyncSettings } from "../types";

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expiry_date: number; // ms epoch
}

/**
 * Manages the Google OAuth2 token lifecycle.
 *
 * Desktop: loopback HTTP server captures the authorization code.
 * Mobile:  obsidian:// custom URI scheme captures the code via
 *          registerObsidianProtocolHandler in main.ts.
 */
export class AuthService {
  private clientId: string;
  private clientSecret: string;
  private tokens: TokenSet | null = null;
  private onTokensChanged: (tokens: TokenSet | null) => void;

  // Scopes required: files (read/write) + drive.metadata (for Changes API)
  static readonly SCOPES = [
    "https://www.googleapis.com/auth/drive",
  ];

  static readonly MOBILE_REDIRECT = "obsidian://gdrive-callback";

  constructor(
    clientId: string,
    clientSecret: string,
    savedTokens: TokenSet | null,
    onTokensChanged: (tokens: TokenSet | null) => void
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokens = savedTokens;
    this.onTokensChanged = onTokensChanged;
  }

  isAuthenticated(): boolean {
    return this.tokens !== null;
  }

  /** Returns a valid access token, refreshing if necessary. */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new Error("Not authenticated");

    // Refresh 60 s before expiry
    if (Date.now() >= this.tokens.expiry_date - 60_000) {
      await this.refresh();
    }
    return this.tokens.access_token;
  }

  /** Build the Google consent URL. redirectUri differs by platform. */
  buildAuthUrl(redirectUri: string, state?: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: AuthService.SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      ...(state ? { state } : {}),
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  /** Exchange an authorization code for tokens. */
  async exchangeCode(code: string, redirectUri: string): Promise<void> {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Token exchange failed: ${err}`);
    }

    const data = await resp.json();
    this.setTokens(data);
  }

  /** Trigger the full OAuth2 flow appropriate for the current platform. */
  async login(): Promise<void> {
    if (Platform.isMobile) {
      await this.loginMobile();
    } else {
      await this.loginDesktop();
    }
  }

  /** Desktop: spin up loopback server, open browser, await callback. */
  private async loginDesktop(): Promise<void> {
    // OAuthServer is a Node.js-only module; import lazily so mobile doesn't choke.
    const { OAuthServer } = await import("./OAuthServer");
    const server = new OAuthServer();
    const { port } = await server.start();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const authUrl = this.buildAuthUrl(redirectUri);

    // Open browser (Electron shell)
    const { shell } = require("electron") as typeof import("electron");
    await shell.openExternal(authUrl);

    const code = await server.waitForCode();
    server.stop();

    await this.exchangeCode(code, redirectUri);
  }

  /**
   * Mobile: open system browser to the consent URL.
   * The code is delivered back via obsidian://gdrive-callback?code=...
   * handled in main.ts via registerObsidianProtocolHandler, which calls
   * AuthService.handleMobileCallback().
   */
  private loginMobile(): Promise<void> {
    const authUrl = this.buildAuthUrl(AuthService.MOBILE_REDIRECT);
    // window.open works in Obsidian mobile (opens system browser)
    window.open(authUrl);
    // Resolution happens asynchronously via handleMobileCallback(); we return
    // a promise that we store so main.ts can resolve it.
    return new Promise((resolve, reject) => {
      this._mobileResolve = resolve;
      this._mobileReject = reject;
      // 5 min timeout
      setTimeout(() => reject(new Error("OAuth timeout")), 5 * 60 * 1000);
    });
  }

  private _mobileResolve?: () => void;
  private _mobileReject?: (e: Error) => void;

  /** Called by main.ts when obsidian://gdrive-callback arrives on mobile. */
  async handleMobileCallback(params: Record<string, string>): Promise<void> {
    try {
      if (params.error) throw new Error(params.error);
      if (!params.code) throw new Error("No code in callback");
      await this.exchangeCode(params.code, AuthService.MOBILE_REDIRECT);
      this._mobileResolve?.();
    } catch (e) {
      this._mobileReject?.(e as Error);
    } finally {
      this._mobileResolve = undefined;
      this._mobileReject = undefined;
    }
  }

  /** Revoke tokens and clear state. */
  async logout(): Promise<void> {
    if (this.tokens?.access_token) {
      // Best-effort revoke; ignore errors
      fetch(
        `https://oauth2.googleapis.com/revoke?token=${this.tokens.access_token}`,
        { method: "POST" }
      ).catch(() => {});
    }
    this.tokens = null;
    this.onTokensChanged(null);
  }

  private async refresh(): Promise<void> {
    if (!this.tokens?.refresh_token) throw new Error("No refresh token");

    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: this.tokens.refresh_token,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "refresh_token",
      }).toString(),
    });

    if (!resp.ok) {
      this.tokens = null;
      this.onTokensChanged(null);
      throw new Error("Token refresh failed — please reconnect your account");
    }

    const data = await resp.json();
    // refresh response doesn't always include a new refresh_token
    this.setTokens({ refresh_token: this.tokens.refresh_token, ...data });
  }

  private setTokens(raw: Record<string, unknown>): void {
    this.tokens = {
      access_token: raw.access_token as string,
      refresh_token: (raw.refresh_token as string) ?? this.tokens?.refresh_token ?? "",
      expiry_date: Date.now() + ((raw.expires_in as number) ?? 3600) * 1000,
    };
    this.onTokensChanged(this.tokens);
  }
}
