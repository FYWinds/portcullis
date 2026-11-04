/**
 * portcullis omp extension: signs omp collab relay connections with an OIDC
 * ID token so the relay can sit behind oauth2-proxy.
 *
 *   /portcullis login    device-code login (opens the browser)
 *   /portcullis status   identity, expiry, signed hosts
 *   /portcullis logout   forget the stored tokens
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { configPath, loadConfig, type PortcullisConfig } from "./config";
import { pollDeviceToken, startDeviceAuthorization, tokenIdentity } from "./oidc";
import { installSocketAuth } from "./socket";
import { createTokenStore } from "./store";
import { TokenManager } from "./tokens";

const STATUS_KEY = "portcullis";
const REFRESH_CHECK_MS = 60_000;
/** Minimum gap between repeated "not signed in" warnings during reconnect storms. */
const WARN_INTERVAL_MS = 60_000;
const SUBCOMMANDS = ["login", "status", "logout"] as const;

function describeExpiry(expiresAt: number): string {
	const minutes = Math.round((expiresAt - Date.now()) / 60_000);
	return minutes > 0 ? `expires in ${minutes} min` : "expired";
}

function describeStatus(config: PortcullisConfig, manager: TokenManager): string {
	const tokens = manager.tokens;
	const who = tokens ? `signed in as ${tokenIdentity(tokens.idToken)} (${describeExpiry(tokens.expiresAt)})` : "signed out";
	const error = manager.lastError ? `; last refresh error: ${manager.lastError}` : "";
	return `portcullis: ${who}; hosts ${config.hosts.join(", ")}; tokens in ${manager.store.kind}${error}`;
}

export default async function portcullis(pi: ExtensionAPI): Promise<void> {
	let config: PortcullisConfig | null = null;
	let configError: string | null = null;
	try {
		config = await loadConfig();
	} catch (err) {
		configError = err instanceof Error ? err.message : String(err);
	}

	const manager = config ? new TokenManager(config, createTokenStore(config)) : null;
	let ui: ExtensionContext["ui"] | null = null;
	let lastWarnAt = 0;
	const signedHosts = new Set<string>();

	if (config && manager) {
		installSocketAuth({
			hosts: new Set(config.hosts),
			token: () => {
				// Kick a refresh on every matched connect; the reconnect after a 401 picks it up.
				void manager.ensureFresh();
				return manager.current();
			},
			onConnect: (host, signed) => {
				if (signed) {
					if (!signedHosts.has(host)) {
						signedHosts.add(host);
						pi.logger.info(`portcullis: signing collab connections to ${host}`);
						ui?.notify(`portcullis: collab connection to ${host} signed as ${tokenIdentity(manager.current()!)}`, "info");
					}
					return;
				}
				const now = Date.now();
				if (now - lastWarnAt < WARN_INTERVAL_MS) return;
				lastWarnAt = now;
				pi.logger.warn(`portcullis: no valid token for ${host}`);
				ui?.notify(`portcullis: not signed in, ${host} will refuse the connection. Run /portcullis login`, "warning");
			},
		});
	}

	function refreshStatus(): void {
		if (!ui || !manager || !config?.statusLine) return;
		const tokens = manager.tokens;
		ui.setStatus(STATUS_KEY, tokens ? `🔐 ${tokenIdentity(tokens.idToken)}` : "🔐 signed out");
	}

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		if (configError) {
			ctx.ui.notify(`portcullis: ${configError}`, "error");
			return;
		}
		// Headless sessions (subagents, print mode, test harnesses) never host or
		// join, and every keychain read from an unapproved binary opens a macOS
		// password prompt. Commands still load the tokens on demand.
		if (!manager || !ctx.hasUI) return;
		await manager.load();
		await manager.ensureFresh();
		refreshStatus();
		ctx.setInterval(async () => {
			await manager.ensureFresh();
			refreshStatus();
		}, REFRESH_CHECK_MS);
	});

	async function login(ctx: ExtensionContext, cfg: PortcullisConfig, mgr: TokenManager): Promise<void> {
		const auth = await startDeviceAuthorization(cfg);
		const url = auth.verificationUriComplete ?? auth.verificationUri;
		ctx.ui.notify(`portcullis: open ${url} and confirm code ${auth.userCode}`, "info");
		// PORTCULLIS_NO_BROWSER=1: print the link only (SSH sessions, headless hosts).
		const opener = process.env.PORTCULLIS_NO_BROWSER
			? null
			: process.platform === "darwin"
				? "open"
				: process.platform === "win32"
					? null
					: "xdg-open";
		if (opener) await pi.exec(opener, [url]).catch(() => undefined);
		const tokens = await pollDeviceToken(cfg, auth);
		await mgr.set(tokens);
		refreshStatus();
		ctx.ui.notify(`portcullis: signed in as ${tokenIdentity(tokens.idToken)} (${describeExpiry(tokens.expiresAt)})`, "info");
	}

	pi.registerCommand("portcullis", {
		description: "Sign omp collab relay connections with your OIDC login (login | status | logout)",
		getArgumentCompletions: prefix =>
			SUBCOMMANDS.filter(s => s.startsWith(prefix.trim())).map(s => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			ui = ctx.ui;
			if (!config || !manager) {
				ctx.ui.notify(
					configError ? `portcullis: ${configError}` : `portcullis: no config at ${configPath()} (see the portcullis README)`,
					"error",
				);
				return;
			}
			await manager.load();
			const sub = args.trim() || "status";
			try {
				switch (sub) {
					case "login":
						await login(ctx, config, manager);
						return;
					case "logout":
						await manager.clear();
						signedHosts.clear();
						refreshStatus();
						ctx.ui.notify("portcullis: signed out", "info");
						return;
					case "status":
						ctx.ui.notify(describeStatus(config, manager), "info");
						return;
					default:
						ctx.ui.notify(`portcullis: unknown subcommand "${sub}" (login | status | logout)`, "error");
				}
			} catch (err) {
				ctx.ui.notify(`portcullis: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// The shortcut also keeps the extension out of omp's deferred startup:
	// extensions registering nothing a first frame needs bind after the
	// composer, and `omp join <link>` connects before that, unsigned (guest
	// joins do not retry). Shortcuts are one of the registrations that force
	// an eager bind (startup-deferral.ts canBindAfterStartup, omp 18.16.0).
	pi.registerShortcut("ctrl+alt+p", {
		description: "portcullis: show sign-in status",
		handler: ctx => {
			ctx.ui.notify(
				config && manager ? describeStatus(config, manager) : `portcullis: ${configError ?? `no config at ${configPath()}`}`,
				config ? "info" : "error",
			);
		},
	});
}
