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

const NAMED_ENTITIES: Record<string, string> = {
	nbsp: " ",
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	laquo: "«",
	raquo: "»",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	copy: "©",
	reg: "®",
	trade: "™",
	euro: "€",
	bull: "•",
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
		if (name[0] === "#") {
			const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
		}
		return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
	});
}

const BLOCK_TAGS = new Set(["address", "article", "aside", "center", "dd", "div", "dl", "dt", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "tfoot", "thead", "tr", "ul"]);
/** Blocks followed by an empty line, as a reader expects between paragraphs. */
const PARAGRAPH_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol"]);

/**
 * Plain text from an HTML body, for a client that cannot show HTML legibly:
 * blocks become line breaks, links keep their address, quoted mail keeps its
 * "> " prefix and entities are decoded. Pattern-based on purpose, since
 * Workers have no DOM parser.
 */
export function htmlToText(html: string): string {
	const source = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
	const lines: string[] = [];
	let line = "";
	let sawText = false;
	let quoteDepth = 0;
	let preDepth = 0;
	let link: { href: string; start: number } | null = null;

	const prefix = () => "> ".repeat(quoteDepth);
	const push = (text: string) => lines.push(`${prefix()}${text}`.trimEnd());
	const breakLine = () => {
		// A list marker waits for its item, even when the item opens a block (<li><p>…).
		if (line === "- ") return;
		if (line.trim()) push(preDepth > 0 ? line : line.trim());
		line = "";
		sawText = false;
	};
	const blankLine = () => {
		if (lines.length && lines[lines.length - 1] !== prefix().trimEnd()) push("");
	};

	for (const [token] of source.matchAll(/<[^>]*>|[^<]+/g)) {
		if (/^<[!?]/.test(token)) continue; // <!DOCTYPE>, <?xml …?>
		const tag = /^<\s*(\/?)\s*([a-z][a-z0-9]*)\b([^>]*)>$/i.exec(token);
		if (!tag) {
			// Text, or a stray "<" that opens no tag.
			if (preDepth > 0) {
				const [first, ...rest] = decodeEntities(token).split("\n");
				line += first;
				for (const part of rest) {
					push(line);
					line = part;
				}
			} else {
				const text = decodeEntities(token.replace(/\s+/g, " "));
				line += line && !line.endsWith(" ") ? text : text.trimStart();
			}
			sawText = true;
			continue;
		}
		const closing = tag[1] === "/";
		const name = tag[2].toLowerCase();
		if (name === "br") {
			if (!line.trim()) push("");
			else breakLine();
			continue;
		}
		if (name === "a") {
			if (!closing) {
				const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[3]);
				link = href ? { href: decodeEntities(href[1] ?? href[2] ?? href[3] ?? "").trim(), start: line.length } : null;
			} else if (link) {
				const label = line.slice(link.start).trim();
				const target = link.href.replace(/^mailto:/i, "");
				if (/^(https?:|mailto:)/i.test(link.href) && label !== target) line += ` (${target})`;
				link = null;
			}
			continue;
		}
		if (name === "blockquote") {
			breakLine();
			// A quote ends at its last line, not at the blank line its last paragraph left.
			if (closing) while (lines.length && lines[lines.length - 1] === prefix().trimEnd()) lines.pop();
			quoteDepth = Math.max(quoteDepth + (closing ? -1 : 1), 0);
			continue;
		}
		if (name === "td" || name === "th") {
			if (!closing && line.trim()) line += " ";
			continue;
		}
		if (!BLOCK_TAGS.has(name)) continue;
		// A block holding only whitespace (Yandex writes "<div> </div>") is an empty line.
		const emptyBlock = closing && !line.trim() && sawText;
		breakLine();
		if (name === "pre") preDepth = Math.max(preDepth + (closing ? -1 : 1), 0);
		if (emptyBlock) blankLine();
		if (name === "li" && !closing) line = "- ";
		if (name === "hr") push("—".repeat(16));
		if (closing && PARAGRAPH_TAGS.has(name)) blankLine();
	}
	breakLine();
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
