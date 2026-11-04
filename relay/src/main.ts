#!/usr/bin/env bun
/**
 * Relay entrypoint: configuration comes from the environment (see README).
 */
import { type RelayConfig, startRelay } from "./relay";

function intEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
	return value;
}

function optionalEnv(name: string): string | null {
	const raw = process.env[name]?.trim();
	return raw ? raw : null;
}

const identityHeader = optionalEnv("PORTCULLIS_IDENTITY_HEADER") ?? "X-Auth-Request-Email";
const hostAllow = optionalEnv("PORTCULLIS_HOST_ALLOW");

const config: RelayConfig = {
	port: intEnv("PORT", 7466),
	hostname: optionalEnv("HOST") ?? "0.0.0.0",
	// "none" is an explicit opt-out for local development; anything else is a header name.
	identityHeader: identityHeader.toLowerCase() === "none" ? null : identityHeader,
	hostAllow: hostAllow
		? new Set(
				hostAllow
					.split(",")
					.map(s => s.trim())
					.filter(Boolean),
			)
		: null,
	maxRooms: intEnv("PORTCULLIS_MAX_ROOMS", 32),
	maxGuestsPerRoom: intEnv("PORTCULLIS_MAX_GUESTS", 16),
	maxPayloadBytes: intEnv("PORTCULLIS_MAX_PAYLOAD_BYTES", 16 * 1024 * 1024),
	idleTimeoutSec: intEnv("PORTCULLIS_IDLE_TIMEOUT_SEC", 120),
	webRoot: optionalEnv("PORTCULLIS_WEB_ROOT"),
	loginUrl: optionalEnv("PORTCULLIS_LOGIN_URL"),
};

const relay = await startRelay(config);
console.log(
	JSON.stringify({
		ts: new Date().toISOString(),
		event: "listening",
		url: relay.url,
		identityHeader: config.identityHeader,
		hostAllow: config.hostAllow ? [...config.hostAllow] : null,
		webRoot: config.webRoot,
		loginUrl: config.loginUrl,
	}),
);

let stopping = false;
async function shutdown(): Promise<void> {
	if (stopping) return;
	stopping = true;
	await relay.stop();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
