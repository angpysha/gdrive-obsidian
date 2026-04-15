/**
 * Manages the Google OAuth2 token lifecycle.
 *
 * Both desktop and mobile use the same web-based redirect flow:
 *   1. Open browser → Google consent URL
 *   2. Google → https://angpysha.github.io/gdrive-obsidian/callback?code=...
 *   3. GitHub Pages page → obsidian://gdrive-callback?code=...
 *   4. Obsidian protocol handler (registered in main.ts) → handleMobileCallback()
 *
 * This eliminates the need for a loopback HTTP server and works identically
 * on desktop (macOS/Windows/Linux) and mobile (iOS/Android).
 */

import type { TokenSet } from "../types";

export type { TokenSet };

export class AuthService {
  private clientId: string;
  private clientSecret: string;
  private tokens: TokenSet | null = null;
  private onTokensChanged: (tokens: TokenSet | null) => void;

  static readonly SCOPES = ["https://www.googleapis.com/auth/drive"];

  static readonly REDIRECT_URI =
    "https://angpysha.github.io/gdrive-obsidian/callback";

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

  /** Returns a valid access token, refreshing silently if near expiry. */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new Error("Not authenticated");
    if (Date.now() >= this.tokens.expiry_date - 60_000) {
      await this.refresh();
    }
    return this.tokens.access_token;
  }

  /** Open the Google consent URL in the system browser (desktop + mobile). */
  async login(): Promise<void> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: AuthService.REDIRECT_URI,
      response_type: "code",
      scope: AuthService.SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
    });
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

    // window.open works on both Electron (desktop) and Obsidian Mobile
    window.open(authUrl);

    // Resolution happens via handleCallback() called by the protocol handler in main.ts
    return new Promise((resolve, reject) => {
      this._pendingResolve = resolve;
      this._pendingReject = reject;
      setTimeout(() => reject(new Error("OAuth timeout — try again")), 5 * 60 * 1000);
    });
  }

  private _pendingResolve?: () => void;
  private _pendingReject?: (e: Error) => void;

  /**
   * Called by main.ts registerObsidianProtocolHandler("gdrive-callback", ...)
   * when obsidian://gdrive-callback?code=... arrives (desktop or mobile).
   */
  async handleCallback(params: Record<string, string>): Promise<void> {
    try {
      if (params.error) throw new Error(params.error);
      if (!params.code) throw new Error("No authorization code received");
      await this.exchangeCode(params.code);
      this._pendingResolve?.();
    } catch (e) {
      this._pendingReject?.(e as Error);
    } finally {
      this._pendingResolve = undefined;
      this._pendingReject = undefined;
    }
  }

  /** Exchange an authorization code for tokens. */
  async exchangeCode(code: string): Promise<void> {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: AuthService.REDIRECT_URI,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Token exchange failed: ${err}`);
    }

    this.setTokens(await resp.json());
  }

  /** Revoke tokens and clear stored state. */
  async logout(): Promise<void> {
    if (this.tokens?.access_token) {
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
    this.setTokens({ refresh_token: this.tokens.refresh_token, ...data });
  }

  private setTokens(raw: Record<string, unknown>): void {
    this.tokens = {
      access_token: raw.access_token as string,
      refresh_token:
        (raw.refresh_token as string) ?? this.tokens?.refresh_token ?? "",
      expiry_date: Date.now() + ((raw.expires_in as number) ?? 3600) * 1000,
    };
    this.onTokensChanged(this.tokens);
  }
}
