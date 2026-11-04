/**
 * Persists the token set: OS keychain via `Bun.secrets` by default, or a 0600
 * file when `tokenFile` is configured or the runtime has no `Bun.secrets`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PortcullisConfig } from "./config";
import type { TokenSet } from "./oidc";

export interface TokenStore {
	readonly kind: "keychain" | "file";
	load(): Promise<TokenSet | null>;
	save(tokens: TokenSet): Promise<void>;
	clear(): Promise<void>;
}

const SERVICE = "portcullis";

function parse(text: string | null): TokenSet | null {
	if (!text) return null;
	try {
		const v = JSON.parse(text) as Partial<TokenSet>;
		if (typeof v.idToken === "string" && typeof v.refreshToken === "string" && typeof v.expiresAt === "number") {
			return { idToken: v.idToken, refreshToken: v.refreshToken, expiresAt: v.expiresAt };
		}
	} catch {
		// A corrupt entry is treated as signed out.
	}
	return null;
}

export function createTokenStore(config: PortcullisConfig): TokenStore {
	// Older Bun runtimes (omp built before Bun 1.2.21) lack Bun.secrets.
	const secrets = "secrets" in Bun ? Bun.secrets : undefined;
	if (!config.tokenFile && secrets) {
		const key = { service: SERVICE, name: `${config.issuer} ${config.clientId}` };
		return {
			kind: "keychain",
			load: async () => parse(await secrets.get(key)),
			save: tokens => secrets.set({ ...key, value: JSON.stringify(tokens) }),
			clear: async () => {
				await secrets.delete(key);
			},
		};
	}
	const file = config.tokenFile ?? path.join(process.env.HOME ?? ".", ".config", "portcullis", "tokens.json");
	return {
		kind: "file",
		load: async () => parse(await fs.readFile(file, "utf8").catch(() => null)),
		async save(tokens) {
			await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
			const tmp = `${file}.${process.pid}.tmp`;
			await fs.writeFile(tmp, JSON.stringify(tokens), { mode: 0o600 });
			await fs.rename(tmp, file);
		},
		clear: () => fs.rm(file, { force: true }),
	};
}
