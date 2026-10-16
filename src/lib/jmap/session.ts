import { CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION, LIMITS } from "./constants";
import { shortHash } from "./format-utils";
import type { JmapContext } from "./types";

/**
 * The Session object (RFC 8620 §2). One account per API key: the key's user.
 * Its `state` is a digest of the Session itself, so it only moves when the
 * Session does: every response carries it as `sessionState`, and clients
 * refetch the Session, and may rebuild the account, whenever it differs.
 */
export function buildSession(ctx: JmapContext) {
	const base = `${ctx.origin}/jmap`;
	const session = {
		capabilities: {
			[CAPABILITY_CORE]: {
				maxSizeUpload: LIMITS.maxSizeUpload,
				maxConcurrentUpload: 4,
				maxSizeRequest: LIMITS.maxSizeRequest,
				maxConcurrentRequests: 4,
				maxCallsInRequest: LIMITS.maxCallsInRequest,
				maxObjectsInGet: LIMITS.maxObjectsInGet,
				maxObjectsInSet: LIMITS.maxObjectsInSet,
				collationAlgorithms: ["i;ascii-casemap", "i;unicode-casemap"],
			},
			[CAPABILITY_MAIL]: {},
			[CAPABILITY_SUBMISSION]: {},
		},
		accounts: {
			[ctx.accountId]: {
				name: ctx.auth.email,
				isPersonal: true,
				isReadOnly: false,
				accountCapabilities: {
					[CAPABILITY_MAIL]: {
						maxMailboxesPerEmail: 1,
						maxMailboxDepth: 2,
						maxSizeMailboxName: 80,
						maxSizeAttachmentsPerEmail: LIMITS.maxSizeAttachmentsPerEmail,
						emailQuerySortOptions: ["receivedAt", "sentAt", "subject", "from", "size", "hasKeyword"],
						mayCreateTopLevelMailbox: false,
					},
					[CAPABILITY_SUBMISSION]: {
						maxDelayedSend: 0,
						submissionExtensions: {},
					},
				},
			},
		},
		primaryAccounts: {
			[CAPABILITY_MAIL]: ctx.accountId,
			[CAPABILITY_SUBMISSION]: ctx.accountId,
		},
		username: ctx.auth.email,
		apiUrl: `${base}/api`,
		downloadUrl: `${base}/download/{accountId}/{blobId}/{name}?type={type}`,
		uploadUrl: `${base}/upload/{accountId}`,
		eventSourceUrl: `${base}/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
	};
	return { ...session, state: shortHash(JSON.stringify(session)) };
}

export function sessionState(ctx: JmapContext): string {
	return buildSession(ctx).state;
}
