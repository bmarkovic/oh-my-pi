/**
 * Daemon credentials. Each configured credential is one control principal, and
 * the upgrade must present exactly one of the two headers. Credential bytes are
 * compared in constant time and are never logged, echoed or placed in a frame.
 */
import { timingSafeEqual } from "node:crypto";

/** Header that carries the control key (`X-Omp-Control-Key`). */
export const CONTROL_KEY_HEADER = "x-omp-control-key";

/** Query parameters that would carry a credential; their presence always rejects the upgrade. */
const FORBIDDEN_QUERY_PARAMETERS = ["token", "key", "access_token"] as const;

/** A stable identity per configured credential; handles are owned by one principal. */
export type ControlPrincipal = "bearer" | "key";

export interface ControlCredentials {
	bearerToken?: string;
	controlKey?: string;
}

/** Throw unless at least one non-empty credential is configured. */
export function validateControlCredentials(credentials: ControlCredentials): void {
	const bearer = credentials.bearerToken;
	const key = credentials.controlKey;
	if (bearer !== undefined && bearer.trim().length === 0) throw new Error("control bearer token must not be blank");
	if (key !== undefined && key.trim().length === 0) throw new Error("control key must not be blank");
	if (bearer === undefined && key === undefined) {
		throw new Error("control server requires a bearer token or a control key");
	}
}

/**
 * Constant-time credential equality. Both sides are reduced to SHA-256 digests of equal length,
 * so the comparison branches on neither the credential's bytes nor its length.
 */
function credentialMatches(presented: string, expected: string): boolean {
	return timingSafeEqual(credentialDigest(presented), credentialDigest(expected));
}

function credentialDigest(value: string): Uint8Array {
	return new Bun.CryptoHasher("sha256").update(value).digest();
}

/**
 * Authenticate a WebSocket upgrade request. Returns the principal, or `undefined`
 * when the request must be refused with HTTP 401.
 */
export function authenticateControlRequest(
	request: Request,
	credentials: ControlCredentials,
): ControlPrincipal | undefined {
	const url = new URL(request.url);
	if (FORBIDDEN_QUERY_PARAMETERS.some(name => url.searchParams.has(name))) return undefined;

	const authorization = request.headers.get("authorization");
	const key = request.headers.get(CONTROL_KEY_HEADER);
	if ((authorization === null) === (key === null)) return undefined;

	if (authorization !== null) {
		const match = /^Bearer (.+)$/.exec(authorization);
		if (!match || credentials.bearerToken === undefined) return undefined;
		return credentialMatches(match[1], credentials.bearerToken) ? "bearer" : undefined;
	}
	if (key === null || credentials.controlKey === undefined) return undefined;
	return credentialMatches(key, credentials.controlKey) ? "key" : undefined;
}
