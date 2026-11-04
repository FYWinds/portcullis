/**
 * The omp collab relay contract, served behind an identity-forwarding auth
 * proxy (Traefik forwardAuth + oauth2-proxy), plus the collab-web client.
 *
 * Protocol (ported from oh-my-pi `packages/collab-web/scripts/local-relay.ts`, MIT):
 * - `GET /r/<roomId>?role=host|guest` upgrades to a WebSocket.
 * - The host creates the room; a second host gets close 4009, a guest joining
 *   a missing room 4004, a guest past the per-room cap 4029.
 * - Binary frames carry `[4B uint32 BE peerId][sealed payload]`. Host frames with
 *   peerId 0 go to every guest, peerId N to guest N. Guest frames get their
 *   first 4 bytes rewritten to the sender's peerId and go to the host.
 * - TEXT control to the host: `{"t":"peer-joined","peer":N}` / `{"t":"peer-left","peer":N}`.
 * - Host disconnect: TEXT `{"t":"room-closed"}` to every guest, close 4001, room dropped.
 *
 * Payloads stay sealed end to end; the relay never holds a room key.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const ENVELOPE_HEADER_BYTES = 4;
const ROOM_CLOSED = JSON.stringify({ t: "room-closed" });

export interface RelayConfig {
	port: number;
	hostname: string;
	/**
	 * Request header carrying the authenticated user, set by the auth proxy
	 * (Traefik copies `X-Auth-Request-*` from oauth2-proxy and strips client
	 * copies). `null` disables the check; only for local development.
	 */
	identityHeader: string | null;
	/** Identities allowed to open rooms as host; `null` lets any identified user host. */
	hostAllow: ReadonlySet<string> | null;
	maxRooms: number;
	maxGuestsPerRoom: number;
	maxPayloadBytes: number;
	idleTimeoutSec: number;
	/** Directory holding the built collab-web client; `null` serves no web UI. */
	webRoot: string | null;
	/**
	 * Login redirect for browser guests, `{rd}` replaced by the encoded page URL
	 * (fragment included). When set, `/` gets a bootstrap that checks
	 * `/auth/check` first, so the room link survives the SSO round trip.
	 */
	loginUrl: string | null;
}

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	/** Assigned on open for guests; the host stays 0. */
	peerId: number;
	identity: string;
}

type RelaySocket = Bun.ServerWebSocket<SocketData>;

interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

export interface Relay {
	url: string;
	port: number;
	roomCount(): number;
	stop(): Promise<void>;
}

function log(event: string, fields: Record<string, unknown> = {}): void {
	console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/** Room ids are routing secrets for guests; log only a prefix. */
function roomTag(roomId: string): string {
	return roomId.slice(0, 6);
}

function bootstrapScript(loginUrl: string): string {
	// Runs before the client. The room link lives in the fragment and must not
	// ride the SSO round trip: as `rd` it would reach oauth2-proxy's logs and
	// the IdP (inside `state`). So the fragment is parked in sessionStorage,
	// the login returns to the bare page, and the fragment is restored
	// synchronously before the client reads it.
	const key = "portcullis.fragment";
	return `<script>(function(){var k=${JSON.stringify(key)},u=${JSON.stringify(loginUrl)};try{var s=sessionStorage.getItem(k);if(s){sessionStorage.removeItem(k);if(!location.hash)history.replaceState(null,"",location.pathname+location.search+s);}}catch(e){}fetch("/auth/check",{credentials:"include",redirect:"manual",cache:"no-store"}).then(function(r){if(r.status!==204)throw 0;}).catch(function(){try{if(location.hash)sessionStorage.setItem(k,location.hash);}catch(e){}location.replace(u.replace("{rd}",encodeURIComponent(location.origin+location.pathname)));});})();</script>`;
}

async function loadIndex(webRoot: string, loginUrl: string | null): Promise<string | null> {
	const file = Bun.file(path.join(webRoot, "index.html"));
	if (!(await file.exists())) return null;
	const html = await file.text();
	if (!loginUrl) return html;
	return html.replace("<head>", `<head>${bootstrapScript(loginUrl)}`);
}

export async function startRelay(config: RelayConfig): Promise<Relay> {
	const rooms = new Map<string, Room>();
	const webRoot = config.webRoot ? path.resolve(config.webRoot) : null;
	const indexHtml = webRoot ? await loadIndex(webRoot, config.loginUrl) : null;

	function identify(req: Request): string | null {
		if (!config.identityHeader) return "anonymous";
		const value = req.headers.get(config.identityHeader)?.trim();
		return value ? value : null;
	}

	async function serveStatic(pathname: string): Promise<Response> {
		if (!webRoot) return new Response("not found", { status: 404 });
		if (pathname === "/" || pathname === "/index.html") {
			if (!indexHtml) return new Response("not found", { status: 404 });
			return new Response(indexHtml, {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
			});
		}
		let decoded: string;
		try {
			decoded = decodeURIComponent(pathname);
		} catch {
			return new Response("bad path", { status: 400 });
		}
		const resolved = path.resolve(webRoot, `.${decoded}`);
		if (!resolved.startsWith(webRoot + path.sep)) return new Response("not found", { status: 404 });
		const stat = await fs.stat(resolved).catch(() => null);
		if (!stat?.isFile()) return new Response("not found", { status: 404 });
		// Build output is content-hashed; public/ assets are not, so cache them briefly.
		const hashed = /^\/[0-9a-z]{8,}\.[a-z0-9]+$/i.test(pathname);
		return new Response(Bun.file(resolved), {
			headers: { "cache-control": hashed ? "public, max-age=31536000, immutable" : "public, max-age=3600" },
		});
	}

	function closeRoom(room: Room): void {
		for (const guest of room.guests.values()) {
			guest.send(ROOM_CLOSED);
			guest.close(4001, "room closed");
		}
		room.guests.clear();
	}

	const server = Bun.serve<SocketData>({
		port: config.port,
		hostname: config.hostname,
		async fetch(req, srv): Promise<Response | undefined> {
			const url = new URL(req.url);
			if (url.pathname === "/healthz") return new Response("ok");

			const identity = identify(req);
			if (url.pathname === "/auth/check") {
				return new Response(null, { status: identity ? 204 : 401, headers: { "cache-control": "no-store" } });
			}

			const match = ROOM_PATH_RE.exec(url.pathname);
			if (!match) {
				if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
				return serveStatic(url.pathname);
			}

			const role = url.searchParams.get("role");
			if (role !== "host" && role !== "guest") return new Response("bad role", { status: 400 });
			if (!identity) return new Response("unauthenticated", { status: 401 });
			const roomId = match[1]!;
			if (role === "host") {
				if (config.hostAllow && !config.hostAllow.has(identity)) {
					log("host_denied", { identity, room: roomTag(roomId) });
					return new Response("not allowed to host", { status: 403 });
				}
				if (!rooms.has(roomId) && rooms.size >= config.maxRooms) {
					log("rooms_exhausted", { identity, rooms: rooms.size });
					return new Response("relay at room capacity", { status: 503 });
				}
			}
			const data: SocketData = { roomId, role, peerId: 0, identity };
			if (srv.upgrade(req, { data })) return undefined;
			return new Response("websocket upgrade required", { status: 426 });
		},
		websocket: {
			maxPayloadLength: config.maxPayloadBytes,
			idleTimeout: config.idleTimeoutSec,
			open(ws: RelaySocket): void {
				const { roomId, role, identity } = ws.data;
				if (role === "host") {
					if (rooms.has(roomId)) {
						ws.close(4009, "a host is already connected for this room");
						return;
					}
					rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
					log("room_open", { identity, room: roomTag(roomId), rooms: rooms.size });
					return;
				}
				const room = rooms.get(roomId);
				if (!room) {
					ws.close(4004, "no such room");
					return;
				}
				if (room.guests.size >= config.maxGuestsPerRoom) {
					ws.close(4029, "room is full");
					return;
				}
				const peerId = room.nextPeerId++;
				ws.data.peerId = peerId;
				room.guests.set(peerId, ws);
				room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
				log("guest_join", { identity, room: roomTag(roomId), peer: peerId, guests: room.guests.size });
			},
			message(ws: RelaySocket, message: string | Buffer): void {
				if (typeof message === "string") return; // clients never send TEXT
				if (message.byteLength < ENVELOPE_HEADER_BYTES) return;
				const room = rooms.get(ws.data.roomId);
				if (!room) return;
				if (ws.data.role === "host") {
					if (room.host !== ws) return;
					const peerId = message.readUInt32BE(0);
					if (peerId === 0) {
						for (const guest of room.guests.values()) guest.send(message);
					} else {
						room.guests.get(peerId)?.send(message);
					}
					return;
				}
				if (room.guests.get(ws.data.peerId) !== ws) return;
				message.writeUInt32BE(ws.data.peerId, 0);
				room.host.send(message);
			},
			close(ws: RelaySocket): void {
				const { roomId, role, peerId, identity } = ws.data;
				const room = rooms.get(roomId);
				if (!room) return;
				if (role === "host") {
					// A rejected second host does not own the live room.
					if (room.host !== ws) return;
					rooms.delete(roomId);
					closeRoom(room);
					log("room_close", { identity, room: roomTag(roomId), rooms: rooms.size });
					return;
				}
				if (room.guests.get(peerId) === ws) {
					room.guests.delete(peerId);
					room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
					log("guest_leave", { identity, room: roomTag(roomId), peer: peerId });
				}
			},
		},
	});

	return {
		url: `ws://${config.hostname === "0.0.0.0" ? "localhost" : config.hostname}:${server.port}`,
		port: server.port!,
		roomCount: () => rooms.size,
		async stop(): Promise<void> {
			for (const room of rooms.values()) {
				closeRoom(room);
				room.host.close(1001, "relay shutting down");
			}
			rooms.clear();
			await server.stop(true);
		},
	};
}
