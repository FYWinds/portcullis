// Dev-only mock OIDC issuer (dev/stack.sh, deploy/docker-compose/compose.local.yaml):
// discovery, JWKS, device code (approves on the second poll), auth code (approves
// at once), refresh. RS256 ID tokens, aud = the requesting client, email = EMAIL.
// Never expose it beyond a dev machine: it signs in anyone who asks.
export {};

const PORT = Number(process.env.PORT ?? 9000);
// ISSUER must be the URL every party uses (plugin, browser, oauth2-proxy); BIND is the listen address.
const ISSUER = process.env.ISSUER ?? `http://127.0.0.1:${PORT}`;
const BIND = process.env.BIND ?? "127.0.0.1";
const BROWSER_URL = process.env.BROWSER_URL ?? ISSUER;
const EMAIL = process.env.EMAIL ?? "dev@example.com";
const TTL = Number(process.env.TTL ?? 3600);

const keys = (await crypto.subtle.generateKey(
	{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
	true,
	["sign", "verify"],
)) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", use: "sig", alg: "RS256" };

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
async function sign(claims: Record<string, unknown>): Promise<string> {
	const head = `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64(claims)}`;
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(head));
	return `${head}.${Buffer.from(sig).toString("base64url")}`;
}
async function tokens(clientId: string) {
	const now = Math.floor(Date.now() / 1000);
	const id_token = await sign({ iss: ISSUER, aud: clientId, sub: "user-1", email: EMAIL, email_verified: true, preferred_username: "dev", iat: now, exp: now + TTL });
	return Response.json({ id_token, access_token: "opaque", refresh_token: `rt-${crypto.randomUUID()}`, token_type: "Bearer", expires_in: TTL });
}

const devices = new Map<string, { clientId: string; polls: number }>();
const codes = new Map<string, string>();
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

Bun.serve({
	port: PORT,
	hostname: BIND,
	async fetch(req) {
		const url = new URL(req.url);
		const form = req.method === "POST" ? new URLSearchParams(await req.text()) : new URLSearchParams();
		switch (url.pathname) {
			case "/.well-known/openid-configuration": {
				// Server-side endpoints follow the caller's origin, so the plugin
				// (via localhost) and oauth2-proxy (via a container name) both
				// reach them; the browser's authorize endpoint is BROWSER_URL.
				const origin = url.origin;
				return Response.json({
					issuer: ISSUER,
					authorization_endpoint: `${BROWSER_URL}/authorize`,
					token_endpoint: `${origin}/token`,
					device_authorization_endpoint: `${origin}/device`,
					jwks_uri: `${origin}/jwks`,
					userinfo_endpoint: `${origin}/userinfo`,
					response_types_supported: ["code"],
					subject_types_supported: ["public"],
					id_token_signing_alg_values_supported: ["RS256"],
				});
			}
			case "/jwks":
				return Response.json({ keys: [jwk] });
			case "/userinfo":
				return Response.json({ sub: "user-1", email: EMAIL, email_verified: true });
			case "/device": {
				const code = crypto.randomUUID();
				devices.set(code, { clientId: form.get("client_id") ?? "", polls: 0 });
				log("device_authorization", form.get("client_id"), form.get("scope"));
				return Response.json({
					device_code: code,
					user_code: "ABCD-EFGH",
					verification_uri: `${BROWSER_URL}/verify`,
					verification_uri_complete: `${BROWSER_URL}/verify?user_code=ABCD-EFGH`,
					expires_in: 300,
					interval: 1,
				});
			}
			case "/authorize": {
				const code = `ac-${crypto.randomUUID()}`;
				codes.set(code, url.searchParams.get("client_id") ?? "");
				const back = new URL(url.searchParams.get("redirect_uri")!);
				back.searchParams.set("code", code);
				back.searchParams.set("state", url.searchParams.get("state") ?? "");
				log("authorize", url.searchParams.get("client_id"));
				return Response.redirect(back.toString(), 302);
			}
			case "/token": {
				const grant = form.get("grant_type");
				const basic = req.headers.get("authorization")?.replace(/^Basic /, "");
				const clientId = form.get("client_id") ?? (basic ? decodeURIComponent(atob(basic).split(":")[0]!) : "");
				log("token", grant, clientId);
				if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
					const d = devices.get(form.get("device_code") ?? "");
					if (!d) return Response.json({ error: "invalid_grant" }, { status: 400 });
					if (d.polls++ < 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
					devices.delete(form.get("device_code")!);
					return tokens(d.clientId);
				}
				if (grant === "authorization_code") {
					const issued = codes.get(form.get("code") ?? "");
					if (!issued) return Response.json({ error: "invalid_grant" }, { status: 400 });
					codes.delete(form.get("code")!);
					return tokens(issued);
				}
				if (grant === "refresh_token") return tokens(clientId);
				return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
			}
		}
		return new Response("not found", { status: 404 });
	},
});
log(`mock oidc at ${ISSUER}`);
