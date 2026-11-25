import type { InboundJob, OutboundJob } from "./jobs";

export interface Env {
	DB: D1Database;
	RAW: R2Bucket;
	INBOUND_QUEUE: Queue<InboundJob>;
	OUTBOUND_QUEUE: Queue<OutboundJob>;
	EMAIL: SendEmail;

	GITHUB_REPO: string;
	GITHUB_APP_ID: string;
	GITHUB_INSTALLATION_ID: string;

	LIST_ADDRESS: string;
	ACCEPT_MODE: string;
	LIST_ID?: string;
	LIST_BOUNCE_PATTERN?: string;
	ACCEPT_HEADER_CHECKS?: string;
	OBSERVE_MODE?: string;
	IGNORE_SENDERS?: string;

	SENDER_ADDRESS: string;
	SENDER_NAME_TEMPLATE?: string;
	SENDER_LABEL?: string;
	CC_LIST?: string;
	CC_EXTRA_RECIPIENTS?: string;
	QUOTE_REPLY?: string;
	SIGNATURE_TEMPLATE?: string;
	FORWARD_DIRECT_REPLIES?: string;

	COMMAND_PREFIX?: string;
	DEFAULT_OUTBOUND_MODE?: string;
	MIN_PERMISSION?: string;

	SUBJECT_TAG?: string;
	FOOTER_PATTERN?: string;
	LABELS_NEW?: string;
	LABEL_AWAITING_REPLY?: string;
	LABEL_ANSWER_OWED?: string;
	LABEL_TO_ACKNOWLEDGE?: string;
	LABEL_AWAITING_REPORTER?: string;
	LABEL_SPAM?: string;
	LABEL_BOUNTY?: string;
	LABEL_UNTHREADED?: string;
	REOPEN_ON_REPORTER_MESSAGE?: string;
	ISSUE_TYPE?: string;
	ACK_TEMPLATE?: string;
	BOUNTY_TEMPLATE?: string;

	ATTACHMENT_MAX_BYTES?: string;
	DOWNLOAD_LINK_TTL_SECONDS?: string;
	PUBLIC_BASE_URL?: string;
	RETENTION_DAYS?: string;
	RETENTION_FROM?: string;

	// Secrets
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	HMAC_SECRET: string;
	INBOUND_ADDRESS?: string;
}
