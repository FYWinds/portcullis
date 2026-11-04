import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PortcullisConfig } from "../src/config";
import type { TokenSet } from "../src/oidc";
import type { TokenStore } from "../src/store";
import { TokenManager } from "../src/tokens";

function jwt(claims: Record<string, unknown>): string {
	const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
	return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

let server: Bun.Server<undefined>;
let refreshCalls = 0;
let refreshResponse: { status: number; body: Record<string, unknown> };

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/.well-known/openid-configuration") {
				return Response.json({
					issuer: `http://127.0.0.1:${server.port}`,
					token_endpoint: `http://127.0.0.1:${server.port}/token`,
					device_authorization_endpoint: `http://127.0.0.1:${server.port}/device`,
				});
			}
			if (url.pathname === "/token") {
				const form = new URLSearchParams(await req.text());
				expect(form.get("grant_type")).toBe("refresh_token");
				refreshCalls++;
				return Response.json(refreshResponse.body, { status: refreshResponse.status });
			}
			return new Response("not found", { status: 404 });
		},
	});
});

afterAll(() => server.stop(true));

function memoryStore(initial: TokenSet | null): TokenStore & { saved: TokenSet | null } {
	const store = {
		kind: "file" as const,
		saved: initial,
		load: async () => store.saved,
		save: async (t: TokenSet) => {
			store.saved = t;
		},
		clear: async () => {
			store.saved = null;
		},
	};
	return store;
}

function setup(expiresInMs: number, now = 1_000_000_000_000) {
	const config: PortcullisConfig = {
		issuer: `http://127.0.0.1:${server.port}`,
		clientId: "cli",
		hosts: ["relay.example"],
		scopes: "openid offline_access",
		tokenFile: null,
		statusLine: true,
	};
	const store = memoryStore({ idToken: jwt({ exp: 0 }), refreshToken: "r1", expiresAt: now + expiresInMs });
	const manager = new TokenManager(config, store, () => now);
	return { manager, store, now };
}

describe("token manager", () => {
	test("current() withholds a token inside the expiry skew", async () => {
		const { manager } = setup(30_000);
		await manager.load();
		expect(manager.current()).toBeNull();
	});

	test("refreshes ahead of expiry once, keeping the refresh token when none is returned", async () => {
		const { manager, store, now } = setup(2 * 60_000);
		await manager.load();
		const fresh = jwt({ exp: Math.floor(now / 1000) + 3600, email: "me@example.com" });
		refreshResponse = { status: 200, body: { id_token: fresh } };
		refreshCalls = 0;
		const [a, b] = await Promise.all([manager.ensureFresh(), manager.ensureFresh()]);
		expect(refreshCalls).toBe(1);
		expect(a).toBe(b);
		expect(manager.current()).toBe(fresh);
		expect(store.saved?.refreshToken).toBe("r1");
	});

	test("skips refresh while the token has plenty of lifetime left", async () => {
		const { manager } = setup(60 * 60_000);
		await manager.load();
		refreshCalls = 0;
		await manager.ensureFresh();
		expect(refreshCalls).toBe(0);
	});

	test("a rejected refresh token signs the user out", async () => {
		const { manager, store } = setup(60_000);
		await manager.load();
		refreshResponse = { status: 400, body: { error: "invalid_grant", error_description: "revoked" } };
		expect(await manager.ensureFresh()).toBeNull();
		expect(manager.signedIn).toBe(false);
		expect(store.saved).toBeNull();
		expect(manager.lastError).toContain("invalid_grant");
	});

	test("a transient refresh failure keeps the stored tokens", async () => {
		const { manager, store } = setup(60_000);
		await manager.load();
		refreshResponse = { status: 503, body: { error: "temporarily_unavailable" } };
		expect(await manager.ensureFresh()).toBeNull();
		expect(manager.signedIn).toBe(true);
		expect(store.saved?.refreshToken).toBe("r1");
	});
});
