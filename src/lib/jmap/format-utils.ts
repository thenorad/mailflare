/**
 * RFC 8620 §1.4 UTCDate: `YYYY-MM-DDThh:mm:ssZ`. Fractional seconds MUST be
 * omitted when zero, and `toISOString` always prints them, which strict ISO 8601
 * parsers (Swift's default one among them) reject. Mailflare stores whole
 * seconds, so they are dropped entirely.
 */
export function utcDate(date: Date): string {
	return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/**
 * `maxBodyValueBytes` counts UTF-8 octets and RFC 8621 §4.2 forbids cutting
 * inside a multi-octet sequence. Slicing the JS string by length does neither,
 * and can split a surrogate pair into JSON a strict decoder refuses. HTML
 * should not be cut inside a tag either, so a trailing partial tag is dropped.
 */
export function clipUtf8(value: string, maxBytes: number, options: { html?: boolean } = {}): { value: string; isTruncated: boolean } {
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { value, isTruncated: false };
	const bytes = new TextEncoder().encode(value);
	if (bytes.length <= maxBytes) return { value, isTruncated: false };
	let end = Math.floor(maxBytes);
	// Step back over continuation bytes (10xxxxxx) so the cut lands before a whole character.
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	let clipped = new TextDecoder().decode(bytes.subarray(0, end));
	if (options.html) {
		const open = clipped.lastIndexOf("<");
		if (open > clipped.lastIndexOf(">")) clipped = clipped.slice(0, open);
	}
	return { value: clipped, isTruncated: true };
}

/** FNV-1a, 32 bits, base 36: a short stable digest for state strings, not for security. */
export function shortHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}
