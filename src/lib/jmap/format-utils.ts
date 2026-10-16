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

/** Unstyled text follows the reader's theme: CanvasText is white in dark mode and black in light mode. */
const THEMED_STYLE = "color-scheme:light dark;color:CanvasText";
/** Mail that paints its own colours was designed for a white page, so it keeps one. */
const LIGHT_CARD_STYLE = "color-scheme:light;background-color:#ffffff;color:#1f1f1f;padding:12px;border-radius:8px";
/** A colour or background of the message's own: CSS declarations, or the legacy bgcolor/text/color attributes. */
const OWN_COLORS = /(?:^|[\s;"'{])(?:color|background(?:-color|-image)?)\s*:|\b(?:bgcolor|text|color)\s*=\s*["']?#?\w/i;

/**
 * Make an HTML body readable on whatever background a client draws it on. A
 * client that renders mail on its dark-mode background without adapting it
 * shows unstyled text black on black. Mail that sets no colours gets its text
 * colour from the reader's theme; mail with colours of its own goes on a light
 * card it was designed for. For a full document the wrapper goes inside
 * <body>, so the head stays where it is.
 */
export function themeAwareHtml(html: string): string {
	const open = `<div style="${OWN_COLORS.test(html) ? LIGHT_CARD_STYLE : THEMED_STYLE}">`;
	const body = /<body\b[^>]*>/i.exec(html);
	if (!body) return `${open}${html}</div>`;
	const start = body.index + body[0].length;
	const end = html.slice(start).search(/<\/body\s*>/i);
	const close = end < 0 ? html.length : start + end;
	return `${html.slice(0, start)}${open}${html.slice(start, close)}</div>${html.slice(close)}`;
}

/**
 * One JSON Pointer reference token (RFC 6901 §4): `~1` is `/` and `~0` is `~`,
 * decoded in that order. PatchObject keys are pointers (RFC 8620 §5.3), so a
 * client patching `mailboxIds/<id>` escapes the `~` in Mailflare's ids.
 */
export function decodePointerToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
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
