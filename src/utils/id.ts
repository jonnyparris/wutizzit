// Room codes avoid look-alike characters (0/O, 1/I/L) so they are easy to read out loud.
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_ID_PATTERN = /^[A-Z0-9]{6}$/;

function randomString(length: number, alphabet: string): string {
	// Rejection sampling keeps the distribution uniform.
	const limit = 256 - (256 % alphabet.length);
	let out = '';
	while (out.length < length) {
		for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
			if (b < limit) out += alphabet[b % alphabet.length];
			if (out.length === length) break;
		}
	}
	return out;
}

export function generateRoomId(): string {
	return randomString(6, ROOM_ALPHABET);
}

/** Public, non-secret identifier shared with every player in the room. */
export function generateId(): string {
	return randomString(12, 'abcdefghijklmnopqrstuvwxyz0123456789');
}

/** Secret per-player session token. Never broadcast. */
export function generateToken(): string {
	return crypto.randomUUID();
}

export function pickRandom<T>(items: readonly T[]): T {
	const [n] = crypto.getRandomValues(new Uint32Array(1));
	return items[n % items.length];
}

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
