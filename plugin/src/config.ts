import * as os from "node:os";
import * as path from "node:path";

export interface PortcullisConfig {
	/** OIDC issuer, e.g. `https://auth.example.com`. */
	issuer: string;
	/** Public (PKCE / device-code) client registered at the issuer. */
	clientId: string;
	/**
	 * Relay hosts (`hostname` or `hostname:port`, lowercase) whose collab
	 * connections carry the token. Every other WebSocket is left untouched, so
	 * the token never reaches `my.omp.sh` or any other relay.
	 */
	hosts: string[];
	scopes: string;
	/** Store tokens in this file (0600) instead of the OS keychain. */
	tokenFile: string | null;
}

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "portcullis", "config.json");

export function configPath(): string {
	return process.env.PORTCULLIS_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
}

function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function parseConfig(raw: unknown, source: string): PortcullisConfig {
	if (!raw || typeof raw !== "object") throw new Error(`${source}: expected a JSON object`);
	const obj = raw as Record<string, unknown>;
	const issuer = typeof obj.issuer === "string" ? obj.issuer.trim().replace(/\/+$/, "") : "";
	let issuerUrl: URL;
	try {
		issuerUrl = new URL(issuer);
	} catch {
		throw new Error(`${source}: "issuer" must be a URL`);
	}
	if (issuerUrl.protocol !== "https:" && !(issuerUrl.protocol === "http:" && isLoopback(issuerUrl.hostname))) {
		throw new Error(`${source}: "issuer" must use https:// (http:// only for localhost)`);
	}
	const clientId = typeof obj.clientId === "string" ? obj.clientId.trim() : "";
	if (!clientId) throw new Error(`${source}: "clientId" is required`);
	if (!Array.isArray(obj.hosts) || obj.hosts.length === 0) {
		throw new Error(`${source}: "hosts" must list at least one relay host`);
	}
	const hosts = obj.hosts.map(h => {
		if (typeof h !== "string" || !/^[a-z0-9.-]+(:\d{1,5})?$/i.test(h.trim())) {
			throw new Error(`${source}: invalid host ${JSON.stringify(h)}; use "hostname" or "hostname:port"`);
		}
		return h.trim().toLowerCase();
	});
	const scopes = typeof obj.scopes === "string" && obj.scopes.trim() ? obj.scopes.trim() : "openid profile email offline_access";
	const tokenFile =
		typeof obj.tokenFile === "string" && obj.tokenFile.trim()
			? path.resolve(obj.tokenFile.trim().replace(/^~(?=\/)/, os.homedir()))
			: null;
	return { issuer, clientId, hosts, scopes, tokenFile };
}

/** `null` when no config file exists; throws on a malformed one. */
export async function loadConfig(file = configPath()): Promise<PortcullisConfig | null> {
	const handle = Bun.file(file);
	if (!(await handle.exists())) return null;
	let raw: unknown;
	try {
		raw = await handle.json();
	} catch (err) {
		throw new Error(`${file}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
	}
	return parseConfig(raw, file);
}
