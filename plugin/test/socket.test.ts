import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installSocketAuth, uninstallSocketAuth } from "../src/socket";

interface Seen {
	authorization: string | null;
	protocol: string | null;
}

let server: Bun.Server<Seen>;
let token: string | null = "tok-1";
const connects: { host: string; signed: boolean }[] = [];

beforeAll(() => {
	server = Bun.serve<Seen>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			const protocol = req.headers.get("sec-websocket-protocol");
			const data = { authorization: req.headers.get("authorization"), protocol };
			const headers = protocol ? { "Sec-WebSocket-Protocol": protocol.split(",")[0]!.trim() } : undefined;
			return srv.upgrade(req, { data, headers }) ? undefined : new Response("no", { status: 400 });
		},
		websocket: {
			open(ws) {
				ws.send(JSON.stringify(ws.data));
			},
			message() {},
		},
	});
	installSocketAuth({
		hosts: new Set([`127.0.0.1:${server.port}`]),
		token: () => token,
		onConnect: (host, signed) => connects.push({ host, signed }),
	});
});

afterAll(() => {
	uninstallSocketAuth();
	server.stop(true);
});

async function handshake(url: string, init?: string | string[]): Promise<Seen> {
	const ws = init === undefined ? new WebSocket(url) : new WebSocket(url, init);
	const { promise, resolve, reject } = Promise.withResolvers<Seen>();
	ws.onmessage = e => resolve(JSON.parse(String(e.data)) as Seen);
	ws.onerror = () => reject(new Error("connect failed"));
	try {
		return await promise;
	} finally {
		ws.close();
	}
}

describe("socket auth hook", () => {
	test("signs connections to configured hosts", async () => {
		token = "tok-1";
		const seen = await handshake(`ws://127.0.0.1:${server.port}/r/abc?role=host`);
		expect(seen.authorization).toBe("Bearer tok-1");
		expect(connects.at(-1)).toEqual({ host: `127.0.0.1:${server.port}`, signed: true });
	});

	test("never sends the token to other hosts", async () => {
		// Same server, different host string: not in the allow-list.
		const seen = await handshake(`ws://localhost:${server.port}/r/abc?role=host`);
		expect(seen.authorization).toBeNull();
	});

	test("keeps subprotocols when signing", async () => {
		token = "tok-2";
		const seen = await handshake(`ws://127.0.0.1:${server.port}/`, ["chat.v1"]);
		expect(seen).toEqual({ authorization: "Bearer tok-2", protocol: "chat.v1" });
	});

	test("connects unsigned and reports it when no token is available", async () => {
		token = null;
		const seen = await handshake(`ws://127.0.0.1:${server.port}/`);
		expect(seen.authorization).toBeNull();
		expect(connects.at(-1)?.signed).toBe(false);
	});

	test("a second install replaces the auth source instead of wrapping twice", async () => {
		installSocketAuth({
			hosts: new Set([`127.0.0.1:${server.port}`]),
			token: () => "tok-3",
			onConnect: () => {},
		});
		const seen = await handshake(`ws://127.0.0.1:${server.port}/`);
		expect(seen.authorization).toBe("Bearer tok-3");
	});
});
