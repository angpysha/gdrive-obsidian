/**
 * Manages the Google OAuth2 token lifecycle using PKCE.
 *
 * PKCE (Proof Key for Code Exchange) eliminates the need for a client secret,
 * making this plugin safe to distribute as a public client.
 *
 * Desktop flow:  loopback HTTP server captures the authorization code.
 * Mobile flow:   obsidian:// URI scheme captures the code directly.
 *                Google allows custom URI schemes for Desktop app client types.
 */

import { Platform } from "obsidian";
import type { TokenSet } from "../types";

export type { TokenSet };

export class AuthService {
  private clientId: string;
  private tokens: TokenSet | null = null;
  private onTokensChanged: (tokens: TokenSet | null) => void;

  // Active PKCE verifier (held in memory during the auth flow)
  private codeVerifier: string | null = null;

  static readonly SCOPES = ["https://www.googleapis.com/auth/drive"];
  static readonly MOBILE_REDIRECT = "obsidian://gdrive-callback";

  constructor(
    clientId: string,
    savedTokens: TokenSet | null,
    onTokensChanged: (tokens: TokenSet | null) => void
  ) {
    this.clientId = clientId;
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

  /** Trigger the full OAuth2 + PKCE login flow. */
  async login(): Promise<void> {
    if (Platform.isMobile) {
      await this.loginMobile();
    } else {
      await this.loginDesktop();
    }
  }

  // ──────────────────────────────────────
  // Desktop: loopback server
  // ──────────────────────────────────────

  private async loginDesktop(): Promise<void> {
    const { OAuthServer } = await import("./OAuthServer");
    const server = new OAuthServer();
    const { port } = await server.start();
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const { verifier, challenge } = await this.generatePKCE();
    this.codeVerifier = verifier;

    const authUrl = this.buildAuthUrl(redirectUri, challenge);
    const { shell } = require("electron") as typeof import("electron");
    await shell.openExternal(authUrl);

    const code = await server.waitForCode();
    server.stop();

    await this.exchangeCode(code, redirectUri);
  }

  // ──────────────────────────────────────
  // Mobile: obsidian:// URI scheme
  // ──────────────────────────────────────

  private loginMobile(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const { verifier, challenge } = await this.generatePKCE();
      this.codeVerifier = verifier;

      const authUrl = this.buildAuthUrl(AuthService.MOBILE_REDIRECT, challenge);
      window.open(authUrl);

      this._pendingResolve = resolve;
      this._pendingReject = reject;
      setTimeout(() => reject(new Error("OAuth timeout — try again")), 5 * 60 * 1000);
    });
  }

  private _pendingResolve?: () => void;
  private _pendingReject?: (e: Error) => void;

  /**
   * Called by main.ts registerObsidianProtocolHandler("gdrive-callback", ...)
   * on both desktop (if using URI scheme) and mobile.
   */
  async handleCallback(params: Record<string, string>): Promise<void> {
    try {
      if (params.error) throw new Error(params.error);
      if (!params.code) throw new Error("No authorization code received");
      await this.exchangeCode(params.code, AuthService.MOBILE_REDIRECT);
      this._pendingResolve?.();
    } catch (e) {
      this._pendingReject?.(e as Error);
    } finally {
      this._pendingResolve = undefined;
      this._pendingReject = undefined;
    }
  }

  /** Exchange an authorization code for tokens (PKCE — no client secret). */
  async exchangeCode(code: string, redirectUri: string): Promise<void> {
    if (!this.codeVerifier) throw new Error("No PKCE verifier — restart the login flow");

    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: this.codeVerifier,
      }).toString(),
    });

    this.codeVerifier = null;

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

  // ──────────────────────────────────────
  // PKCE helpers
  // ──────────────────────────────────────

  private async generatePKCE(): Promise<{ verifier: string; challenge: string }> {
    const verifier = this.base64url(crypto.getRandomValues(new Uint8Array(64)));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = this.base64url(new Uint8Array(digest));
    return { verifier, challenge };
  }

  private base64url(buf: Uint8Array): string {
    return btoa(String.fromCharCode(...buf))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  private buildAuthUrl(redirectUri: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: AuthService.SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  // ──────────────────────────────────────
  // Token refresh (no client secret needed for PKCE)
  // ──────────────────────────────────────

  private async refresh(): Promise<void> {
    if (!this.tokens?.refresh_token) throw new Error("No refresh token");

    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: this.tokens.refresh_token,
        client_id: this.clientId,
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
      refresh_token: (raw.refresh_token as string) ?? this.tokens?.refresh_token ?? "",
      expiry_date: Date.now() + ((raw.expires_in as number) ?? 3600) * 1000,
    };
    this.onTokensChanged(this.tokens);
  }
}
