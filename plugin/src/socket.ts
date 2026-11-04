/**
 * Adds `Authorization: Bearer <id token>` to WebSocket connections opened to
 * configured relay hosts.
 *
 * omp's collab client (`src/collab/relay-client.ts`) opens its relay socket
 * through the global `WebSocket` (`Reflect.construct(WebSocket, [url, options])`
 * since 2026-09-22, `new WebSocket(url)` before), and Bun's constructor accepts
 * a `headers` option. Swapping the global for a subclass is the only hook omp
 * exposes for this today. If omp ever stops using the global, the relay's auth
 * proxy refuses the unsigned socket: the failure is closed, never open.
 */

export interface SocketAuth {
	/** Lowercase `hostname` / `hostname:port` entries to sign. */
	hosts: ReadonlySet<string>;
	/** Current bearer token, or `null` when signed out or expired. */
	token(): string | null;
	/** Called on every matched connect, with whether a token was attached. */
	onConnect(host: string, signed: boolean): void;
}

/** Bun's constructor accepts subprotocols or its own options object as the second argument. */
type WebSocketInit = string | string[] | Bun.WebSocketOptions | undefined;
// Bun types the global as two overloads; a single union signature covers both.
type WebSocketCtor = new (url: string | URL, init?: WebSocketInit) => WebSocket;

interface HookState {
	original: WebSocketCtor;
	auth: SocketAuth | null;
}

const STATE_KEY = Symbol.for("portcullis.websocket-hook");

type Global = typeof globalThis & { [STATE_KEY]?: HookState };

/** `host` (with port when explicit) of a ws/wss URL, or `null`. */
export function relayHost(url: string | URL): string | null {
	let parsed: URL;
	try {
		parsed = new URL(String(url));
	} catch {
		return null;
	}
	if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") return null;
	return parsed.host.toLowerCase();
}

function withAuthorization(init: WebSocketInit, token: string): Bun.WebSocketOptions {
	const options: Bun.WebSocketOptions =
		init === undefined ? {} : typeof init === "string" || Array.isArray(init) ? { protocols: init } : { ...init };
	const headers = new Headers(options.headers as ConstructorParameters<typeof Headers>[0]);
	headers.set("Authorization", `Bearer ${token}`);
	return { ...options, headers: Object.fromEntries(headers.entries()) };
}

/**
 * Install the hook once per process; later calls (another session, a reload)
 * only swap the auth source. Module globals are shared across omp sessions,
 * so the state lives on `globalThis` under a registered symbol.
 */
export function installSocketAuth(auth: SocketAuth): void {
	const g = globalThis as Global;
	const existing = g[STATE_KEY];
	if (existing) {
		existing.auth = auth;
		return;
	}
	const state: HookState = { original: g.WebSocket as unknown as WebSocketCtor, auth };
	g[STATE_KEY] = state;
	const Original = state.original;

	class PortcullisWebSocket extends Original {
		constructor(url: string | URL, init?: WebSocketInit) {
			const current = state.auth;
			const host = current ? relayHost(url) : null;
			if (!current || !host || !current.hosts.has(host)) {
				super(url, init);
				return;
			}
			const token = current.token();
			current.onConnect(host, token !== null);
			super(url, token ? withAuthorization(init, token) : init);
		}
	}
	Object.defineProperty(PortcullisWebSocket, "name", { value: "WebSocket" });
	g.WebSocket = PortcullisWebSocket as unknown as typeof WebSocket;
}

/** Restore the original global (tests). */
export function uninstallSocketAuth(): void {
	const g = globalThis as Global;
	const state = g[STATE_KEY];
	if (!state) return;
	g.WebSocket = state.original as unknown as typeof WebSocket;
	delete g[STATE_KEY];
}
