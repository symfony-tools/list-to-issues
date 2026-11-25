import { isValidAddress, normalizeAddress } from "./addresses";
import type { Env } from "./env";

export type AcceptMode = "list-headers" | "secret-address";
export type Permission = "read" | "triage" | "write" | "maintain" | "admin";

export interface HeaderCheck {
	name: string;
	pattern: RegExp;
}

export interface Config {
	repoOwner: string;
	repoName: string;
	appId: string;
	installationId: string;

	listAddress: string;
	acceptMode: AcceptMode;
	listId: string;
	bouncePattern: RegExp | null;
	inboundAddress: string;
	headerChecks: HeaderCheck[];
	observe: boolean;
	// Addresses, and domains with their subdomains, whose messages are dropped
	ignoreSenders: string[];

	senderAddress: string;
	senderNameTemplate: string;
	senderLabel: string;
	ccList: boolean;
	ccExtraRecipients: boolean;
	quoteReply: boolean;
	signature: string;
	forwardDirectReplies: boolean;

	commandPrefix: string;
	defaultOutboundMode: "none" | "reply";
	minPermission: Permission;

	subjectTag: string;
	footerPattern: RegExp | null;
	labelsNew: string[];
	labelAwaitingReply: string;
	labelAnswerOwed: string;
	labelToAcknowledge: string;
	labelAwaitingReporter: string;
	labelSpam: string;
	labelBounty: string;
	labelUnthreaded: string;
	reopenOnReporterMessage: boolean;
	issueType: string;
	ackTemplate: string;
	bountyTemplate: string;

	attachmentMaxBytes: number;
	downloadLinkTtl: number;
	publicBaseUrl: string;
	retentionDays: number | null;
	retentionFrom: "closed" | "received";

	webhookSecret: string;
	hmacSecret: string;
	privateKey: string;
}

export class ConfigError extends Error {}

const PERMISSIONS: Permission[] = ["read", "triage", "write", "maintain", "admin"];

function required(env: Env, name: keyof Env): string {
	const value = env[name];
	if (typeof value !== "string" || "" === value.trim()) {
		throw new ConfigError(`Missing setting ${name}`);
	}

	return value.trim();
}

function optional(value: string | undefined, fallback: string): string {
	return undefined === value ? fallback : value.trim();
}

function bool(value: string | undefined, fallback: boolean): boolean {
	if (undefined === value || "" === value.trim()) {
		return fallback;
	}

	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function integer(name: string, value: string | undefined, fallback: number): number {
	if (undefined === value || "" === value.trim()) {
		return fallback;
	}
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) {
		throw new ConfigError(`Setting ${name} must be a positive integer`);
	}

	return n;
}

function regex(name: string, value: string | undefined, flags: string): RegExp | null {
	if (undefined === value || "" === value.trim()) {
		return null;
	}
	try {
		return new RegExp(value, flags);
	} catch {
		throw new ConfigError(`Setting ${name} is not a valid regular expression`);
	}
}

function address(name: string, value: string): string {
	if (!isValidAddress(value)) {
		throw new ConfigError(`Setting ${name} is not a valid email address`);
	}

	return normalizeAddress(value);
}

function oneOf<T extends string>(name: string, value: string, choices: readonly T[]): T {
	if (!choices.includes(value as T)) {
		throw new ConfigError(`Setting ${name} must be one of: ${choices.join(", ")}`);
	}

	return value as T;
}

function headerChecks(value: string | undefined): HeaderCheck[] {
	if (undefined === value || "" === value.trim()) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ConfigError("Setting ACCEPT_HEADER_CHECKS must be a JSON array");
	}
	if (!Array.isArray(parsed)) {
		throw new ConfigError("Setting ACCEPT_HEADER_CHECKS must be a JSON array");
	}

	return parsed.map((entry) => {
		if (null === entry || "object" !== typeof entry || "string" !== typeof entry.name || "string" !== typeof entry.pattern) {
			throw new ConfigError('Each entry of ACCEPT_HEADER_CHECKS needs a "name" and a "pattern"');
		}
		const pattern = regex("ACCEPT_HEADER_CHECKS", entry.pattern, "i");
		if (null === pattern) {
			throw new ConfigError('Each entry of ACCEPT_HEADER_CHECKS needs a "pattern"');
		}

		return { name: entry.name.toLowerCase(), pattern };
	});
}

export function loadConfig(env: Env): Config {
	const repo = required(env, "GITHUB_REPO").split("/");
	if (2 !== repo.length || !repo[0] || !repo[1]) {
		throw new ConfigError('Setting GITHUB_REPO must look like "owner/name"');
	}

	const acceptMode = oneOf("ACCEPT_MODE", required(env, "ACCEPT_MODE"), ["list-headers", "secret-address"] as const);
	const observe = bool(env.OBSERVE_MODE, false);
	const listId = optional(env.LIST_ID, "").replace(/^<|>$/g, "").toLowerCase();
	const bouncePattern = regex("LIST_BOUNCE_PATTERN", env.LIST_BOUNCE_PATTERN, "i");
	const inboundAddress = env.INBOUND_ADDRESS ? address("INBOUND_ADDRESS", env.INBOUND_ADDRESS) : "";
	const senderAddress = address("SENDER_ADDRESS", required(env, "SENDER_ADDRESS"));

	if (!observe) {
		if ("list-headers" === acceptMode && ("" === listId || null === bouncePattern)) {
			throw new ConfigError("The list-headers mode needs LIST_ID and LIST_BOUNCE_PATTERN");
		}
		if ("secret-address" === acceptMode && "" === inboundAddress) {
			throw new ConfigError("The secret-address mode needs the INBOUND_ADDRESS secret");
		}
	}
	if ("" !== inboundAddress && "secret-address" === acceptMode && inboundAddress === senderAddress) {
		throw new ConfigError("The secret inbound address must differ from SENDER_ADDRESS");
	}

	const retentionDays = integer("RETENTION_DAYS", env.RETENTION_DAYS, 0);
	const hmacSecret = required(env, "HMAC_SECRET");
	if (hmacSecret.length < 32) {
		throw new ConfigError("The HMAC_SECRET secret must have at least 32 characters");
	}

	return {
		repoOwner: repo[0],
		repoName: repo[1],
		appId: required(env, "GITHUB_APP_ID"),
		installationId: required(env, "GITHUB_INSTALLATION_ID"),

		listAddress: address("LIST_ADDRESS", required(env, "LIST_ADDRESS")),
		acceptMode,
		listId,
		bouncePattern,
		inboundAddress,
		headerChecks: headerChecks(env.ACCEPT_HEADER_CHECKS),
		observe,
		ignoreSenders: optional(env.IGNORE_SENDERS, "").toLowerCase().split(/[\s,]+/).map((entry) => entry.replace(/^@/, "")).filter((entry) => "" !== entry),

		senderAddress,
		senderNameTemplate: optional(env.SENDER_NAME_TEMPLATE, "{commenter} via {label}"),
		senderLabel: optional(env.SENDER_LABEL, ""),
		ccList: bool(env.CC_LIST, false),
		ccExtraRecipients: bool(env.CC_EXTRA_RECIPIENTS, true),
		quoteReply: bool(env.QUOTE_REPLY, true),
		signature: optional(env.SIGNATURE_TEMPLATE, ""),
		forwardDirectReplies: bool(env.FORWARD_DIRECT_REPLIES, false),

		commandPrefix: optional(env.COMMAND_PREFIX, "/") || "/",
		defaultOutboundMode: oneOf("DEFAULT_OUTBOUND_MODE", optional(env.DEFAULT_OUTBOUND_MODE, "none") || "none", ["none", "reply"] as const),
		minPermission: oneOf("MIN_PERMISSION", optional(env.MIN_PERMISSION, "write") || "write", PERMISSIONS),

		subjectTag: optional(env.SUBJECT_TAG, ""),
		footerPattern: regex("FOOTER_PATTERN", env.FOOTER_PATTERN, "m"),
		labelsNew: optional(env.LABELS_NEW, "via-email").split(",").map((label) => label.trim()).filter((label) => "" !== label),
		labelAwaitingReply: optional(env.LABEL_AWAITING_REPLY, "needs-reply"),
		labelAnswerOwed: optional(env.LABEL_ANSWER_OWED, ""),
		labelToAcknowledge: optional(env.LABEL_TO_ACKNOWLEDGE, ""),
		labelAwaitingReporter: optional(env.LABEL_AWAITING_REPORTER, ""),
		labelSpam: optional(env.LABEL_SPAM, "spam") || "spam",
		labelBounty: optional(env.LABEL_BOUNTY, ""),
		labelUnthreaded: optional(env.LABEL_UNTHREADED, "unthreaded") || "unthreaded",
		reopenOnReporterMessage: bool(env.REOPEN_ON_REPORTER_MESSAGE, true),
		issueType: optional(env.ISSUE_TYPE, ""),
		ackTemplate: optional(env.ACK_TEMPLATE, ""),
		bountyTemplate: optional(env.BOUNTY_TEMPLATE, ""),

		attachmentMaxBytes: integer("ATTACHMENT_MAX_BYTES", env.ATTACHMENT_MAX_BYTES, 262144),
		downloadLinkTtl: integer("DOWNLOAD_LINK_TTL_SECONDS", env.DOWNLOAD_LINK_TTL_SECONDS, 900) || 900,
		publicBaseUrl: optional(env.PUBLIC_BASE_URL, "").replace(/\/+$/, ""),
		retentionDays: 0 === retentionDays ? null : retentionDays,
		retentionFrom: oneOf("RETENTION_FROM", optional(env.RETENTION_FROM, "closed") || "closed", ["closed", "received"] as const),

		webhookSecret: required(env, "GITHUB_WEBHOOK_SECRET"),
		hmacSecret,
		privateKey: required(env, "GITHUB_APP_PRIVATE_KEY"),
	};
}

export function isIgnoredSender(address: string, cfg: Config): boolean {
	const domain = address.slice(address.lastIndexOf("@") + 1);

	return cfg.ignoreSenders.some((entry) => (entry.includes("@") ? entry === address : domain === entry || domain.endsWith(`.${entry}`)));
}

export function permissionRank(permission: string): number {
	return PERMISSIONS.indexOf(permission as Permission) + 1;
}
