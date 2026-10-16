import type { JmapRequest, JmapResponse } from "./types";

/**
 * One log line per /jmap/api request, so a client's behaviour can be followed
 * in Workers logs: method names, argument shapes, requested properties and
 * error types. Values that can carry mail content or addresses (bodies, search
 * text, recipients, patch values) are reduced to their keys or counts.
 */
export function describeExchange(request: JmapRequest, response: JmapResponse, ms: number): string {
	return JSON.stringify({
		jmap: "api",
		ms,
		using: request.using.map((capability) => capability.replace("urn:ietf:params:jmap:", "")),
		calls: request.methodCalls.map(([name, args, callId]) => `${callId} ${name}(${describeArgs(args ?? {})})`),
		results: response.methodResponses.map(([name, args, callId]) => `${callId} ${name === "error" ? `error:${String(args.type)}` : `${name}${describeResult(args)}`}`),
	});
}

function describeArgs(args: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (key === "accountId") continue;
		if (key.startsWith("#")) {
			const ref = value as { resultOf?: string; name?: string; path?: string };
			parts.push(`${key}=${ref?.resultOf}:${ref?.name}${ref?.path}`);
		} else if (key === "properties" || key === "bodyProperties") {
			parts.push(Array.isArray(value) ? `${key}=[${value.join(",")}]` : `${key}=${String(value)}`);
		} else if (key === "filter") {
			parts.push(`filter=${describeFilter(value)}`);
		} else if (key === "sort" && Array.isArray(value)) {
			parts.push(`sort=${value.map((item: { property?: string; isAscending?: boolean }) => `${item?.property}:${item?.isAscending ? "asc" : "desc"}`).join(",")}`);
		} else if (key === "update" && value && typeof value === "object") {
			const keys = new Set(Object.values(value as Record<string, Record<string, unknown>>).flatMap((patch) => Object.keys(patch ?? {})));
			parts.push(`update#${Object.keys(value).length}{${[...keys].slice(0, 12).join(",")}}`);
		} else if ((key === "create" || key === "emails") && value && typeof value === "object") {
			const keys = new Set(Object.values(value as Record<string, Record<string, unknown>>).flatMap((item) => Object.keys(item ?? {})));
			parts.push(`${key}#${Object.keys(value).length}{${[...keys].slice(0, 20).join(",")}}`);
		} else if (typeof value === "boolean" || typeof value === "number" || value === null) {
			parts.push(`${key}=${String(value)}`);
		} else if (typeof value === "string") {
			// States and anchors are opaque server tokens; anything else may be user text.
			parts.push(/state$/i.test(key) || key === "anchor" ? `${key}=${value}` : `${key}=…`);
		} else if (Array.isArray(value)) {
			parts.push(`${key}#${value.length}`);
		} else if (value && typeof value === "object") {
			parts.push(`${key}#${Object.keys(value).length}`);
		}
	}
	return parts.join(" ");
}

function describeFilter(filter: unknown): string {
	if (!filter || typeof filter !== "object") return String(filter);
	const node = filter as Record<string, unknown>;
	if (typeof node.operator === "string") {
		return `${node.operator}(${(Array.isArray(node.conditions) ? node.conditions : []).map(describeFilter).join(",")})`;
	}
	return Object.entries(node)
		.map(([key, value]) => {
			if (key === "inMailbox" || /keyword$/i.test(key)) return `${key}=${String(value)}`;
			if (key === "inMailboxOtherThan" && Array.isArray(value)) return `${key}=[${value.join(",")}]`;
			if (key === "header" && Array.isArray(value)) return `header=${String(value[0])}${value.length > 1 ? "=…" : ""}`;
			if (typeof value === "boolean" || typeof value === "number") return `${key}=${value}`;
			return key;
		})
		.join("&");
}

function describeResult(result: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(result)) {
		if (key === "accountId") continue;
		if (Array.isArray(value)) {
			if (value.length) parts.push(`${key}#${value.length}`);
		} else if (value && typeof value === "object") {
			const entries = Object.entries(value as Record<string, unknown>);
			if (!entries.length) continue;
			// SetErrors are worth their type; created/updated maps only their size.
			const errors = key.startsWith("not") ? entries.map(([, error]) => (error as { type?: string })?.type).join(",") : "";
			parts.push(errors ? `${key}#${entries.length}[${errors}]` : `${key}#${entries.length}`);
		} else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			parts.push(`${key}=${String(value)}`);
		}
	}
	return parts.length ? ` ${parts.join(" ")}` : "";
}
