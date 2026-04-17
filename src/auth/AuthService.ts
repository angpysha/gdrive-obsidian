/**
 * Manages the Google OAuth2 token lifecycle using PKCE.
 *
 * PKCE (Proof Key for Code Exchange) eliminates the need for a client secret,
 * making this plugin safe to distribute as a public client.
 *
 * Both desktop and mobile use the same flow:
 *   1. Open Google consent URL in the system browser.
 *   2. Google redirects to https://angpysha.github.io/gdrive-obsidian/callback
 *   3. That page immediately redirects to obsidian://gdrive-callback?code=…
 *   4. Obsidian's protocol handler fires handleCallback(), resolving the promise.
 *
 * iOS note: window.open() is blocked by WKWebView after any await. To avoid
 * this, call prepareAuthUrl() asynchronously first (e.g. when the settings tab
 * renders), then call openLogin() synchronously from the button click handler.
 */

import { Platform, requestUrl } from "obsidian";
import { log } from "../util/Logger";
import type { TokenSet } from "../types";

export type { TokenSet };

export class AuthService {
  private clientId: string;
  private clientSecret: string;
  private tokens: TokenSet | null = null;
  private onTokensChanged: (tokens: TokenSet | null) => void;

  // Active PKCE verifier (held in memory during the auth flow)
  private codeVerifier: string | null = null;

  // Pre-generated auth URL — set by prepareAuthUrl(), consumed by openLogin()
  private _prepared: { url: string; verifier: string } | null = null;

  // Pending promise callbacks — resolved by handleCallback()
  private _pendingResolve?: () => void;
  private _pendingReject?: (e: Error) => void;

  static readonly SCOPES = ["https://www.googleapis.com/auth/drive"];

  /**
   * GitHub Pages redirect bridge.
   * Add this URI as an authorised redirect in your Google Cloud Console
   * (OAuth client type: Web application).
   * The page at this URL redirects to obsidian://gdrive-callback?code=…
   */
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
    if (!this.tokens.access_token) {
      this.tokens = null;
      this.onTokensChanged(null);
      throw new Error("Stored token is invalid — please reconnect your account");
    }
    if (Date.now() >= this.tokens.expiry_date - 60_000) {
      log("info", "Access token expiring — refreshing");
      await this.refresh();
    }
    return this.tokens.access_token;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Login flow
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Pre-generate the PKCE pair and auth URL asynchronously.
   *
   * Call this when the settings tab renders (before the user clicks Connect),
   * so that openLogin() can call window.open() synchronously — avoiding iOS
   * WKWebView's popup-blocking restriction that fires after any await.
   */
  async prepareAuthUrl(): Promise<void> {
    const { verifier, challenge } = await this.generatePKCE();
    this._prepared = {
      url: this.buildAuthUrl(AuthService.REDIRECT_URI, challenge),
      verifier,
    };
  }

  /**
   * Open the pre-prepared auth URL synchronously and return a promise that
   * resolves when handleCallback() is called by the protocol handler.
   *
   * Must be called from a synchronous button-click handler (no await before
   * this call) so that iOS allows window.open().
   */
  openLogin(): Promise<void> {
    if (!this._prepared) {
      return Promise.reject(
        new Error("Auth URL not prepared. Try again — the page needs a moment to initialise.")
      );
    }

    log("info", `openLogin: opening browser (mobile=${Platform.isMobile})`);
    const { url, verifier } = this._prepared;
    this._prepared = null;
    this.codeVerifier = verifier;

    return new Promise((resolve, reject) => {
      // Open synchronously — no await before this point.
      if (!Platform.isMobile) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const electron = require("electron") as { shell: { openExternal(url: string): void } };
          electron.shell.openExternal(url);
        } catch {
          window.open(url);
        }
      } else {
        window.open(url);
      }

      this._pendingResolve = resolve;
      this._pendingReject = reject;
      setTimeout(
        () => reject(new Error("OAuth timeout — please try again")),
        5 * 60_000
      );
    });
  }

  /**
   * Convenience wrapper used when a fresh login is triggered without a
   * pre-prepared URL (e.g. from a command or programmatic call).
   * On iOS this will still work but may fail if called from an async context —
   * prefer prepareAuthUrl() + openLogin() for the settings UI button.
   */
  async login(): Promise<void> {
    if (!this._prepared) {
      await this.prepareAuthUrl();
    }
    return this.openLogin();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // OAuth callback
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Called by main.ts registerObsidianProtocolHandler("gdrive-callback", …)
   * on both desktop and mobile.
   */
  async handleCallback(params: Record<string, string>): Promise<void> {
    log("info", `handleCallback: code=${params.code ? "present" : "missing"} error=${params.error ?? "none"}`);
    try {
      if (params.error) throw new Error(params.error);
      if (!params.code) throw new Error("No authorization code received");
      await this.exchangeCode(params.code, AuthService.REDIRECT_URI);
      log("info", "handleCallback: token exchange succeeded");
      this._pendingResolve?.();
    } catch (e) {
      log("error", `handleCallback: failed — ${e}`);
      this._pendingReject?.(e as Error);
    } finally {
      this._pendingResolve = undefined;
      this._pendingReject = undefined;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Token exchange & refresh
  // ──────────────────────────────────────────────────────────────────────────

  /** Exchange an authorization code for tokens. */
  async exchangeCode(code: string, redirectUri: string): Promise<void> {
    if (!this.codeVerifier)
      throw new Error("No PKCE verifier — restart the login flow");

    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: this.codeVerifier,
    }).toString();

    this.codeVerifier = null;

    log("info", "exchangeCode: calling oauth2.googleapis.com/token");
    const resp = await requestUrl({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      throw: false,
    });

    log("info", `exchangeCode: response status=${resp.status}`);
    if (resp.status >= 400) {
      throw new Error(`Token exchange failed: ${resp.text}`);
    }

    const json = resp.json as Record<string, unknown>;
    log("info", `exchangeCode: got access_token=${json.access_token ? "yes" : "MISSING"} refresh_token=${json.refresh_token ? "yes" : "MISSING"}`);
    this.setTokens(json);
  }

  /** Revoke tokens and clear stored state. */
  async logout(): Promise<void> {
    if (this.tokens?.access_token) {
      requestUrl({
        url: `https://oauth2.googleapis.com/revoke?token=${this.tokens.access_token}`,
        method: "POST",
        throw: false,
      }).catch(() => {});
    }
    this.tokens = null;
    this.onTokensChanged(null);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PKCE helpers
  // ──────────────────────────────────────────────────────────────────────────

  private async generatePKCE(): Promise<{ verifier: string; challenge: string }> {
    const verifier = this.base64url(crypto.getRandomValues(new Uint8Array(64)));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier)
    );
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

  // ──────────────────────────────────────────────────────────────────────────
  // Token refresh (PKCE — no client secret needed)
  // ──────────────────────────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    if (!this.tokens?.refresh_token) throw new Error("No refresh token");

    const resp = await requestUrl({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: this.tokens.refresh_token,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "refresh_token",
      }).toString(),
      throw: false,
    });

    if (resp.status >= 400) {
      this.tokens = null;
      this.onTokensChanged(null);
      throw new Error("Token refresh failed — please reconnect your account");
    }

    this.setTokens({ refresh_token: this.tokens.refresh_token, ...resp.json });
  }

  private setTokens(raw: Record<string, unknown>): void {
    this.tokens = {
      access_token: raw.access_token as string,
      refresh_token:
        (raw.refresh_token as string) ?? this.tokens?.refresh_token ?? "",
      expiry_date:
        Date.now() + ((raw.expires_in as number) ?? 3600) * 1000,
    };
    this.onTokensChanged(this.tokens);
  }
}
