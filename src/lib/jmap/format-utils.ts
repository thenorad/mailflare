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

/**
 * A white card with dark text, stated three ways because a client's HTML
 * sanitizer may keep only some of them: inline CSS with plain hex values, the
 * legacy bgcolor attribute, and <font color>. A theme-following colour
 * (color-scheme with CanvasText) does not survive Jovra's renderer.
 */
const LIGHT_CARD_OPEN =
	'<table role="presentation" width="100%" cellpadding="12" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;background-color:#ffffff;color:#1f1f1f;border-radius:8px">' +
	'<tr><td bgcolor="#ffffff" style="background-color:#ffffff;color:#1f1f1f"><font color="#1f1f1f">';
const LIGHT_CARD_CLOSE = "</font></td></tr></table>";

/**
 * Put an HTML body on a light card. Most mail is written for a white page and
 * sets no text colour, so a client that draws it on its dark-mode background
 * without adapting it shows black on black. For a full document the card goes
 * inside <body>, so the head stays where it is.
 */
export function onLightCard(html: string): string {
	const body = /<body\b[^>]*>/i.exec(html);
	if (!body) return `${LIGHT_CARD_OPEN}${html}${LIGHT_CARD_CLOSE}`;
	const start = body.index + body[0].length;
	const end = html.slice(start).search(/<\/body\s*>/i);
	const close = end < 0 ? html.length : start + end;
	return `${html.slice(0, start)}${LIGHT_CARD_OPEN}${html.slice(start, close)}${LIGHT_CARD_CLOSE}${html.slice(close)}`;
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
