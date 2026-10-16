import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Same approach as jmap-email-import.test.mjs: bundle the TypeScript through the
// `@/*` alias and test the pure parts, which never reach a Workers binding.
const outDir = mkdtempSync(join(tmpdir(), "mailflare-jmap-objects-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { buildEmailObject } from "./src/lib/jmap/email-objects.ts";
			export { clipUtf8, decodePointerToken, utcDate } from "./src/lib/jmap/format-utils.ts";
			export { bodyBlobId, decodeBlobId, encodeMailboxRef } from "./src/lib/jmap/ids.ts";
			export { filterToSql, mailboxRefCondition } from "./src/lib/jmap/email-query.ts";
			export { buildSession, sessionState } from "./src/lib/jmap/session.ts";
			export { describeExchange } from "./src/lib/jmap/log-utils.ts";
			import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
			const dialect = new SQLiteSyncDialect();
			export const render = (fragment) => dialect.sqlToQuery(fragment);
		`,
		resolveDir: root,
		sourcefile: "jmap-objects-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const {
	buildEmailObject,
	clipUtf8,
	decodePointerToken,
	utcDate,
	bodyBlobId,
	decodeBlobId,
	encodeMailboxRef,
	filterToSql,
	mailboxRefCondition,
	buildSession,
	sessionState,
	describeExchange,
	render,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

function row(overrides = {}) {
	return {
		id: "msg_1",
		userId: "usr_1",
		mailboxId: "mbx1",
		direction: "inbound",
		providerMessageId: "<abc@example.com>",
		folderId: null,
		fromAddr: "Rostislav <r@example.com>",
		toAddr: "me@example.org",
		ccAddr: null,
		bccAddr: null,
		subject: "test",
		snippet: "ffff",
		textBody: "ffff",
		htmlBody: "<div>ffff</div>",
		rawR2Key: "inbound/1.eml",
		status: "received",
		read: false,
		starred: false,
		snoozedUntil: null,
		threadId: "abc@example.com",
		inReplyTo: null,
		references: null,
		createdAt: new Date("2026-10-16T14:44:00Z"),
		...overrides,
	};
}

const options = { fetchBodies: true, maxBodyValueBytes: 0 };

test("every leaf body part has a blobId that names its decoded body (RFC 8621 §4.1.4)", () => {
	const email = buildEmailObject(row(), [], options);
	const leaves = email.bodyStructure.subParts;
	assert.equal(email.bodyStructure.type, "multipart/alternative");
	assert.equal(email.bodyStructure.blobId, null);
	assert.deepEqual(
		leaves.map((part) => [part.partId, part.type, part.blobId]),
		[
			["1", "text/plain", bodyBlobId("msg_1", "txt")],
			["2", "text/html", bodyBlobId("msg_1", "htm")],
		],
	);
	assert.equal(email.htmlBody[0].blobId, bodyBlobId("msg_1", "htm"));
	assert.equal(email.textBody[0].blobId, bodyBlobId("msg_1", "txt"));
	assert.deepEqual(decodeBlobId(bodyBlobId("msg_1", "htm")), { kind: "htm", id: "msg_1" });
	assert.deepEqual(decodeBlobId(bodyBlobId("msg_1", "txt")), { kind: "txt", id: "msg_1" });
	assert.equal(decodeBlobId("zzz~msg_1"), null);
});

test("a message without bodies still exposes a downloadable empty text part", () => {
	const email = buildEmailObject(row({ textBody: null, htmlBody: null }), [], options);
	assert.equal(email.bodyStructure.type, "text/plain");
	assert.equal(email.bodyStructure.blobId, bodyBlobId("msg_1", "txt"));
});

test("UTCDate values carry no fractional seconds (RFC 8620 §1.4)", () => {
	const email = buildEmailObject(row(), [], options);
	assert.equal(email.receivedAt, "2026-10-16T14:44:00Z");
	assert.equal(email.sentAt, "2026-10-16T14:44:00Z");
	assert.equal(utcDate(new Date("2026-10-16T14:44:00.789Z")), "2026-10-16T14:44:00Z");
});

test("the headers property is present and in raw form", () => {
	const email = buildEmailObject(row(), [], options);
	const byName = Object.fromEntries(email.headers.map((header) => [header.name, header.value]));
	assert.equal(byName.Subject, " test");
	assert.equal(byName["Message-ID"], " <abc@example.com>");
	assert.equal(byName.From, " Rostislav <r@example.com>");
	assert.equal(byName.Cc, undefined);
	assert.equal(byName["MIME-Version"], " 1.0");
});

test("maxBodyValueBytes counts UTF-8 octets and never cuts a character in half", () => {
	assert.deepEqual(clipUtf8("Ответ", 0), { value: "Ответ", isTruncated: false });
	assert.deepEqual(clipUtf8("Ответ", 10), { value: "Ответ", isTruncated: false });
	// Cyrillic letters are two octets: 5 octets hold two whole letters, not two and a half.
	assert.deepEqual(clipUtf8("Ответ", 5), { value: "От", isTruncated: true });
	// An emoji is four octets (a surrogate pair in JS); a cut inside it drops it whole.
	assert.deepEqual(clipUtf8("ok👍", 4), { value: "ok", isTruncated: true });

	const email = buildEmailObject(row({ textBody: "Ответ👍", htmlBody: null }), [], { fetchBodies: true, maxBodyValueBytes: 11 });
	assert.deepEqual(email.bodyValues["1"], { value: "Ответ", isTruncated: true, isEncodingProblem: false });
	// The JSON a client decodes contains no lone surrogate.
	assert.doesNotMatch(JSON.stringify(email.bodyValues), /\\ud[89a-f]/i);
});

test("a truncated HTML body value does not end inside a tag", () => {
	assert.deepEqual(clipUtf8('<p>Hi</p><a href="https://example.com">x</a>', 20, { html: true }), { value: "<p>Hi</p>", isTruncated: true });
	assert.deepEqual(clipUtf8("<p>Hi</p>tail", 11, { html: true }), { value: "<p>Hi</p>ta", isTruncated: true });
	assert.deepEqual(clipUtf8("a < b and more text", 8, { html: false }), { value: "a < b an", isTruncated: true });
});

test("patch keys are JSON Pointers: ~0 and ~1 in a mailbox id are decoded (RFC 6901)", () => {
	// What Jovra sends to move a message to Trash: the `~` in Mailflare's ids escaped as `~0`.
	assert.equal(decodePointerToken("mbx_5W1Ce-EpemRxq-pm79RXC~0trash"), "mbx_5W1Ce-EpemRxq-pm79RXC~trash");
	assert.equal(decodePointerToken("mbx1~0f~0fld1"), "mbx1~f~fld1");
	assert.equal(decodePointerToken("a~1b"), "a/b");
	// ~01 is an escaped "~" followed by "1", never a "/".
	assert.equal(decodePointerToken("~01"), "~1");
	// Clients that do not escape still work: a bare ~ followed by a letter is left alone.
	assert.equal(decodePointerToken("mbx1~trash"), "mbx1~trash");
});

test("the raw Message-ID header has angle brackets even when the row stores none", () => {
	const email = buildEmailObject(row({ direction: "outbound", status: "sent", providerMessageId: "out-1@example.org" }), [], options);
	assert.equal(email.headers.find((header) => header.name === "Message-ID").value, " <out-1@example.org>");
	assert.deepEqual(email.messageId, ["out-1@example.org"]);
});

test("the address-level Mailbox holds no Email, matching mailboxIds", () => {
	const account = encodeMailboxRef({ kind: "account", mailboxId: "mbx1" });
	assert.equal(render(mailboxRefCondition({ kind: "account", mailboxId: "mbx1" })).sql, "0");
	assert.equal(render(filterToSql({ inMailbox: account }, new Set(["mbx1"]))).sql, "0");
	const email = buildEmailObject(row({ status: "sent", direction: "outbound" }), [], options);
	assert.deepEqual(Object.keys(email.mailboxIds), [encodeMailboxRef({ kind: "role", mailboxId: "mbx1", role: "sent" })]);
});

test("sessionState is a digest of the Session, not of the mail in it", () => {
	const ctx = { accountId: "usr_1", origin: "https://mail.example.org", auth: { email: "me@example.org" } };
	const session = buildSession(ctx);
	assert.equal(session.state, sessionState(ctx));
	assert.equal(sessionState(ctx), sessionState({ ...ctx }));
	assert.notEqual(sessionState(ctx), sessionState({ ...ctx, origin: "https://other.example.org" }));
});

test("the request log names methods and properties but leaks no mail content", () => {
	const line = describeExchange(
		{
			using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
			methodCalls: [
				["Email/query", { accountId: "usr_1", filter: { inMailbox: "mbx1~inbox", text: "secret search" }, sort: [{ property: "receivedAt" }], limit: 50 }, "c0"],
				["Email/get", { accountId: "usr_1", "#ids": { resultOf: "c0", name: "Email/query", path: "/ids" }, properties: ["bodyValues", "htmlBody"], fetchHTMLBodyValues: true }, "c1"],
				["Email/set", { accountId: "usr_1", create: { k1: { subject: "Private subject", bodyValues: { 1: { value: "Private body" } } } }, update: { msg_1: { "keywords/$seen": true } } }, "c2"],
				["Email/changes", { accountId: "usr_1", sinceState: "5.1.0.0.8.0" }, "c3"],
			],
		},
		{
			methodResponses: [
				["Email/query", { accountId: "usr_1", ids: ["msg_1"], position: 0 }, "c0"],
				["Email/get", { accountId: "usr_1", list: [{ id: "msg_1", subject: "Private subject" }], notFound: [] }, "c1"],
				["Email/set", { accountId: "usr_1", created: {}, notCreated: { k1: { type: "invalidProperties", description: "Private" } }, updated: { msg_1: null } }, "c2"],
				["error", { type: "cannotCalculateChanges" }, "c3"],
			],
			sessionState: "x",
		},
		12,
	);
	assert.match(line, /Email\/get\(#ids=c0:Email\/query\/ids properties=\[bodyValues,htmlBody\] fetchHTMLBodyValues=true\)/);
	assert.match(line, /filter=inMailbox=mbx1~inbox&text/);
	assert.match(line, /update#1\{keywords\/\$seen\}/);
	assert.match(line, /notCreated#1\[invalidProperties\]/);
	assert.match(line, /c3 error:cannotCalculateChanges/);
	assert.doesNotMatch(line, /secret search|Private subject|Private body/);
});
