/**
 * Minimal OIDC client for a public client: device authorization grant
 * (RFC 8628) for login, refresh_token grant to keep the ID token fresh.
 */
import type { PortcullisConfig } from "./config";

export interface TokenSet {
	idToken: string;
	refreshToken: string;
	/** ID token `exp`, in ms since the epoch. */
	expiresAt: number;
}

export interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string | null;
	expiresAt: number;
	intervalMs: number;
}

interface Endpoints {
	deviceAuthorization: string;
	token: string;
}

const endpointCache = new Map<string, Promise<Endpoints>>();

async function discover(issuer: string): Promise<Endpoints> {
	const res = await fetch(`${issuer}/.well-known/openid-configuration`);
	if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
	const doc = (await res.json()) as Record<string, unknown>;
	const deviceAuthorization = doc.device_authorization_endpoint;
	const token = doc.token_endpoint;
	if (typeof token !== "string") throw new Error("OIDC discovery: no token_endpoint");
	if (typeof deviceAuthorization !== "string") {
		throw new Error("OIDC discovery: issuer has no device_authorization_endpoint (device code grant unsupported)");
	}
	return { deviceAuthorization, token };
}

function endpoints(issuer: string): Promise<Endpoints> {
	let cached = endpointCache.get(issuer);
	if (!cached) {
		cached = discover(issuer);
		cached.catch(() => endpointCache.delete(issuer));
		endpointCache.set(issuer, cached);
	}
	return cached;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
	const part = token.split(".")[1];
	if (!part) throw new Error("not a JWT");
	return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Display identity: email, then preferred_username, then sub. */
export function tokenIdentity(idToken: string): string {
	const claims = decodeJwtPayload(idToken);
	for (const key of ["email", "preferred_username", "sub"]) {
		const value = claims[key];
		if (typeof value === "string" && value) return value;
	}
	return "unknown";
}

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(form),
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: res.status, body };
}

function oauthError(body: Record<string, unknown>, status: number): string {
	const code = typeof body.error === "string" ? body.error : `HTTP ${status}`;
	const detail = typeof body.error_description === "string" ? `: ${body.error_description}` : "";
	return `${code}${detail}`;
}

function toTokenSet(body: Record<string, unknown>, previousRefresh?: string): TokenSet {
	const idToken = body.id_token;
	if (typeof idToken !== "string") throw new Error("token response has no id_token (is the openid scope granted?)");
	const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : previousRefresh;
	if (!refreshToken) throw new Error("token response has no refresh_token (is offline_access granted?)");
	const exp = decodeJwtPayload(idToken).exp;
	if (typeof exp !== "number") throw new Error("id_token has no exp claim");
	return { idToken, refreshToken, expiresAt: exp * 1000 };
}

export async function startDeviceAuthorization(config: PortcullisConfig): Promise<DeviceAuthorization> {
	const { deviceAuthorization } = await endpoints(config.issuer);
	const { status, body } = await postForm(deviceAuthorization, { client_id: config.clientId, scope: config.scopes });
	if (status !== 200) throw new Error(`device authorization failed: ${oauthError(body, status)}`);
	const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = body;
	if (typeof device_code !== "string" || typeof user_code !== "string" || typeof verification_uri !== "string") {
		throw new Error("device authorization response is missing device_code, user_code or verification_uri");
	}
	return {
		deviceCode: device_code,
		userCode: user_code,
		verificationUri: verification_uri,
		verificationUriComplete: typeof verification_uri_complete === "string" ? verification_uri_complete : null,
		expiresAt: Date.now() + (typeof expires_in === "number" ? expires_in : 600) * 1000,
		intervalMs: (typeof interval === "number" ? interval : 5) * 1000,
	};
}

/** Poll the token endpoint until the user approves, denies, or the code expires. */
export async function pollDeviceToken(
	config: PortcullisConfig,
	auth: DeviceAuthorization,
	signal?: AbortSignal,
): Promise<TokenSet> {
	const { token } = await endpoints(config.issuer);
	let intervalMs = auth.intervalMs;
	while (Date.now() < auth.expiresAt) {
		await Bun.sleep(intervalMs);
		signal?.throwIfAborted();
		const { status, body } = await postForm(token, {
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: auth.deviceCode,
			client_id: config.clientId,
		});
		if (status === 200) return toTokenSet(body);
		switch (body.error) {
			case "authorization_pending":
				continue;
			case "slow_down":
				intervalMs += 5000;
				continue;
			default:
				throw new Error(`login failed: ${oauthError(body, status)}`);
		}
	}
	throw new Error("login failed: the device code expired before it was approved");
}

export class RefreshRejected extends Error {}

export async function refreshTokens(config: PortcullisConfig, refreshToken: string): Promise<TokenSet> {
	const { token } = await endpoints(config.issuer);
	const { status, body } = await postForm(token, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: config.clientId,
		scope: config.scopes,
	});
	if (status === 200) return toTokenSet(body, refreshToken);
	// invalid_grant: revoked, expired, or the user lost access. Re-login needed.
	if (body.error === "invalid_grant") throw new RefreshRejected(`refresh rejected: ${oauthError(body, status)}`);
	throw new Error(`token refresh failed: ${oauthError(body, status)}`);
}
