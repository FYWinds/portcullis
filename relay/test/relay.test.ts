import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Relay, type RelayConfig, startRelay } from "../src/relay";

const ROOM = "room_abcdefghij";
const IDENTITY = "X-Auth-Request-Email";

// The DOM lib's WebSocket type hides Bun's options overload.
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
let relay: Relay | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
	for (const ws of sockets.splice(0)) ws.close();
	await relay?.stop();
	relay = undefined;
});

async function start(overrides: Partial<RelayConfig> = {}): Promise<Relay> {
	relay = await startRelay({
		port: 0,
		hostname: "127.0.0.1",
		identityHeader: IDENTITY,
		hostAllow: null,
		maxRooms: 8,
		maxGuestsPerRoom: 4,
		maxPayloadBytes: 1024 * 1024,
		idleTimeoutSec: 120,
		webRoot: null,
		loginUrl: null,
		...overrides,
	});
	return relay;
}

interface Peer {
	ws: WebSocket;
	messages: (string | Uint8Array)[];
	closed: Promise<{ code: number; reason: string }>;
	next(): Promise<string | Uint8Array>;
}

function connect(role: "host" | "guest", identity: string | null = "me@example.com", room = ROOM): Promise<Peer> {
	const headers: Record<string, string> = identity ? { [IDENTITY]: identity } : {};
	const ws = new BunWebSocket(`${relay!.url}/r/${room}?role=${role}`, { headers });
	ws.binaryType = "arraybuffer";
	sockets.push(ws);
	const messages: (string | Uint8Array)[] = [];
	const waiters: ((m: string | Uint8Array) => void)[] = [];
	ws.onmessage = e => {
		const m = typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer);
		const waiter = waiters.shift();
		if (waiter) waiter(m);
		else messages.push(m);
	};
	const closedSignal = Promise.withResolvers<{ code: number; reason: string }>();
	ws.onclose = e => closedSignal.resolve({ code: e.code, reason: e.reason });
	const closed = closedSignal.promise;
	const peer: Peer = {
		ws,
		messages,
		closed,
		next: () => {
			const queued = messages.shift();
			if (queued !== undefined) return Promise.resolve(queued);
			const { promise, resolve } = Promise.withResolvers<string | Uint8Array>();
			waiters.push(resolve);
			return promise;
		},
	};
	const opened = Promise.withResolvers<Peer>();
	ws.onopen = () => opened.resolve(peer);
	ws.onerror = () => opened.reject(new Error("connect failed"));
	return opened.promise;
}

function envelope(peerId: number, payload: string): Uint8Array {
	const body = new TextEncoder().encode(payload);
	const out = new Uint8Array(4 + body.length);
	new DataView(out.buffer).setUint32(0, peerId);
	out.set(body, 4);
	return out;
}

function decode(frame: string | Uint8Array): { peer: number; payload: string } {
	if (typeof frame === "string") throw new Error(`expected binary, got ${frame}`);
	return {
		peer: new DataView(frame.buffer, frame.byteOffset).getUint32(0),
		payload: new TextDecoder().decode(frame.subarray(4)),
	};
}

async function httpStatus(pathname: string, headers: Record<string, string> = {}): Promise<number> {
	const res = await fetch(`${relay!.url.replace("ws://", "http://")}${pathname}`, { headers, redirect: "manual" });
	await res.arrayBuffer();
	return res.status;
}

describe("room protocol", () => {
	test("routes broadcast, targeted and guest frames with rewritten peer ids", async () => {
		await start();
		const host = await connect("host");
		const a = await connect("guest");
		expect(JSON.parse((await host.next()) as string)).toEqual({ t: "peer-joined", peer: 1 });
		const b = await connect("guest");
		expect(JSON.parse((await host.next()) as string)).toEqual({ t: "peer-joined", peer: 2 });

		host.ws.send(envelope(0, "everyone"));
		expect(decode(await a.next()).payload).toBe("everyone");
		expect(decode(await b.next()).payload).toBe("everyone");

		host.ws.send(envelope(2, "only-b"));
		expect(decode(await b.next())).toEqual({ peer: 2, payload: "only-b" });

		// A guest cannot impersonate another guest: the relay stamps the sender.
		a.ws.send(envelope(2, "from-a"));
		expect(decode(await host.next())).toEqual({ peer: 1, payload: "from-a" });

		// Targeted frames reach only their peer: a's next frame is the following broadcast.
		host.ws.send(envelope(0, "after"));
		expect(decode(await a.next()).payload).toBe("after");
	});

	test("host disconnect closes the room for every guest", async () => {
		await start();
		const host = await connect("host");
		const guest = await connect("guest");
		host.ws.close();
		expect(JSON.parse((await guest.next()) as string)).toEqual({ t: "room-closed" });
		expect((await guest.closed).code).toBe(4001);
		expect(relay!.roomCount()).toBe(0);
	});

	test("guest leaving notifies the host", async () => {
		await start();
		const host = await connect("host");
		const guest = await connect("guest");
		await host.next();
		guest.ws.close();
		expect(JSON.parse((await host.next()) as string)).toEqual({ t: "peer-left", peer: 1 });
	});

	test("second host gets 4009 and does not tear down the live room", async () => {
		await start();
		const host = await connect("host");
		const second = await connect("host");
		expect((await second.closed).code).toBe(4009);
		const guest = await connect("guest");
		expect(JSON.parse((await host.next()) as string)).toEqual({ t: "peer-joined", peer: 1 });
		host.ws.send(envelope(0, "still-here"));
		expect(decode(await guest.next()).payload).toBe("still-here");
	});

	test("guest for a missing room gets 4004", async () => {
		await start();
		const guest = await connect("guest");
		expect((await guest.closed).code).toBe(4004);
	});

	test("guest past the per-room cap gets 4029", async () => {
		await start({ maxGuestsPerRoom: 1 });
		await connect("host");
		await connect("guest");
		const extra = await connect("guest");
		expect((await extra.closed).code).toBe(4029);
	});
});

describe("access control", () => {
	test("upgrade without the identity header is refused", async () => {
		await start();
		expect(await httpStatus(`/r/${ROOM}?role=host`, { Upgrade: "websocket", Connection: "Upgrade" })).toBe(401);
		await expect(connect("host", null)).rejects.toThrow();
	});

	test("only allow-listed identities may host; any identified user may join", async () => {
		await start({ hostAllow: new Set(["owner@example.com"]) });
		await expect(connect("host", "someone@example.com")).rejects.toThrow();
		const host = await connect("host", "owner@example.com");
		await connect("guest", "someone@example.com");
		expect(JSON.parse((await host.next()) as string)).toEqual({ t: "peer-joined", peer: 1 });
	});

	test("new rooms past the room cap are refused; existing hosts unaffected", async () => {
		await start({ maxRooms: 1 });
		await connect("host", "me@example.com", "room_aaaaaaaaaa");
		await expect(connect("host", "me@example.com", "room_bbbbbbbbbb")).rejects.toThrow();
		expect(relay!.roomCount()).toBe(1);
	});

	test("/auth/check mirrors the identity header; /healthz needs none", async () => {
		await start();
		expect(await httpStatus("/auth/check")).toBe(401);
		expect(await httpStatus("/auth/check", { [IDENTITY]: "me@example.com" })).toBe(204);
		expect(await httpStatus("/healthz")).toBe(200);
	});
});

describe("web client", () => {
	test("serves index with the login bootstrap and refuses paths outside the web root", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "portcullis-web-"));
		await fs.writeFile(path.join(dir, "index.html"), "<html><head><title>x</title></head></html>");
		await fs.writeFile(path.join(dir, "abcdef1234.js"), "console.log(1)");
		await fs.writeFile(path.join(os.tmpdir(), "portcullis-outside.txt"), "secret");
		await start({ webRoot: dir, loginUrl: "https://login.example/start?rd={rd}" });
		const base = relay!.url.replace("ws://", "http://");

		const index = await fetch(`${base}/`);
		const html = await index.text();
		expect(html).toContain('fetch("/auth/check"');
		expect(html).toContain("https://login.example/start?rd={rd}");
		expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("<title>"));

		const asset = await fetch(`${base}/abcdef1234.js`);
		expect(await asset.text()).toBe("console.log(1)");
		expect(asset.headers.get("cache-control")).toContain("immutable");

		expect(await httpStatus("/%2e%2e/portcullis-outside.txt")).toBe(404);
		expect(await httpStatus("/missing.js")).toBe(404);
		await fs.rm(dir, { recursive: true });
	});
});
