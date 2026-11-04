import type { PortcullisConfig } from "./config";
import { RefreshRejected, refreshTokens, type TokenSet } from "./oidc";
import type { TokenStore } from "./store";

/** Treat a token as expired this long before its `exp`, for clock skew and transit. */
const EXPIRY_SKEW_MS = 60_000;
/** Refresh in the background once less than this much lifetime is left. */
export const REFRESH_AHEAD_MS = 5 * 60_000;

/**
 * Holds the current token set. `current()` is synchronous because the socket
 * hook runs inside the `WebSocket` constructor; refreshes happen ahead of
 * expiry so a connect normally finds a valid token.
 */
export class TokenManager {
	#tokens: TokenSet | null = null;
	#loaded: Promise<void> | null = null;
	#refreshing: Promise<TokenSet | null> | null = null;
	/** Last refresh failure, for status display. */
	lastError: string | null = null;

	constructor(
		readonly config: PortcullisConfig,
		readonly store: TokenStore,
		private readonly now: () => number = Date.now,
	) {}

	load(): Promise<void> {
		this.#loaded ??= this.store.load().then(tokens => {
			this.#tokens ??= tokens;
		});
		return this.#loaded;
	}

	get signedIn(): boolean {
		return this.#tokens !== null;
	}

	get tokens(): TokenSet | null {
		return this.#tokens;
	}

	/** A non-expired ID token, or `null`. Never blocks. */
	current(): string | null {
		const t = this.#tokens;
		return t && t.expiresAt - EXPIRY_SKEW_MS > this.now() ? t.idToken : null;
	}

	async set(tokens: TokenSet): Promise<void> {
		this.#tokens = tokens;
		this.lastError = null;
		await this.store.save(tokens);
	}

	async clear(): Promise<void> {
		this.#tokens = null;
		await this.store.clear();
	}

	/** Refresh when within {@link REFRESH_AHEAD_MS} of expiry. Single-flight. */
	ensureFresh(): Promise<TokenSet | null> {
		const t = this.#tokens;
		if (!t) return Promise.resolve(null);
		if (t.expiresAt - REFRESH_AHEAD_MS > this.now()) return Promise.resolve(t);
		this.#refreshing ??= this.#refresh(t).finally(() => {
			this.#refreshing = null;
		});
		return this.#refreshing;
	}

	async #refresh(t: TokenSet): Promise<TokenSet | null> {
		try {
			const next = await refreshTokens(this.config, t.refreshToken);
			await this.set(next);
			return next;
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : String(err);
			// A rejected refresh token never recovers: drop it so status says "signed out".
			if (err instanceof RefreshRejected) await this.clear();
			return null;
		}
	}
}
