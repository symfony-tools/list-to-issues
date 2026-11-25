import { type Address, isValidAddress, normalizeAddress, uniqueAddresses } from "../addresses";
import { type App, attachmentPrefix, MailError, ref } from "../app";
import { permissionRank } from "../config";
import { createDownloadUrl } from "../download";
import type { GitHubComment } from "../github/types";
import { parseMail } from "../inbound/parse";
import { quotableText } from "../inbound/render";
import { ACK, backoff, type CommentJob, type JobResult, type OutboundJob, retryIn } from "../jobs";
import { escapeMarkdown, formatSize } from "../markdown";
import { clearReportLabels, setReportStatus } from "../status";
import type { Thread } from "../store";
import { type Command, parseCommand, parseCommentReference } from "./commands";
import { compose, fill, linksToRepository, type Quote } from "./compose";
import { attachUploads, UploadError } from "./uploads";

// The email already left or was refused: what follows must not make the job run again.
async function quietly(action: () => Promise<unknown>, app: App): Promise<void> {
	try {
		await action();
	} catch {
		app.log("feedback_failed");
	}
}

async function refuse(command: GitHubComment, reason: string, app: App): Promise<JobResult> {
	await app.github.addReaction(command.id, "confused");
	await app.github.createComment(command.issueNumber, `Not sent: ${reason}`);
	app.log("outbound_refused", { comment: await ref(command.id) });

	return ACK;
}

async function loadQuote(thread: Thread, app: App): Promise<Quote | null> {
	const row = await app.store.getMessage(thread.lastReporterMessageId ?? thread.rootMessageId);
	const object = row?.r2_key ? await app.raw.get(row.r2_key) : null;
	if (null === object) {
		return null;
	}
	const mail = await parseMail(await object.arrayBuffer(), app.cfg);

	return { date: mail.date, name: mail.sender.name || mail.sender.address, text: quotableText(mail, app.cfg) };
}

// Emails a comment. `command` is the comment that asked for it and gets the feedback,
// `sourceId` is the comment whose text is sent: they differ for "/send". With `showCopy`,
// the text is also posted on the issue, for emails whose text isn't in any comment.
async function send(command: GitHubComment, sourceId: number, markdown: string, explicitRetry: boolean, thread: Thread, attempts: number, app: App, showCopy = false): Promise<JobResult> {
	const { cfg, github, store } = app;
	if ("" === markdown.trim()) {
		return refuse(command, "there is nothing to send.", app);
	}

	const earlier = await store.getOutbound(sourceId);
	if ("done" === earlier?.status) {
		// Either this job is delivered twice, or someone asks for a second send
		return command.id === sourceId ? ACK : refuse(command, "this comment was already sent.", app);
	}
	if ("pending" === earlier?.status) {
		// An attempt was interrupted between the claim and the answer of the email service
		await store.setOutboundStatus(sourceId, "unknown");

		return refuse(command, `the status of this email is unknown, because an earlier attempt was interrupted while sending. Check with the recipient before \`${cfg.commandPrefix}send ${sourceId}\`, which sends it again.`, app);
	}
	if ("unknown" === earlier?.status && !explicitRetry) {
		return ACK;
	}

	let prepared: Awaited<ReturnType<typeof attachUploads>>;
	try {
		prepared = await attachUploads(markdown, github);
	} catch (error) {
		if (error instanceof UploadError) {
			return refuse(command, "a file uploaded in the comment could not be fetched, and the recipient cannot open its link.", app);
		}
		throw error;
	}
	const html = await github.renderMarkdown(prepared.markdown);
	if (linksToRepository(prepared.markdown, cfg) || linksToRepository(html, cfg)) {
		return refuse(command, "the comment links to this repository, which the recipient cannot open. Remove the link and send again.", app);
	}

	const mail = await compose({
		thread,
		commentId: sourceId,
		commenter: command.login,
		markdown: prepared.markdown,
		html,
		quote: cfg.quoteReply ? await loadQuote(thread, app) : null,
		attachments: prepared.attachments,
	}, cfg);

	// Claim the comment right before sending: from here on, a retry must not send again
	if (earlier) {
		await store.setOutboundStatus(sourceId, "pending");
	} else if (!(await store.claimOutbound(sourceId, thread.issueNumber, app.now().toISOString()))) {
		return ACK;
	}

	let messageId: string;
	try {
		messageId = await app.mailer.send(mail);
	} catch (error) {
		if (!(error instanceof MailError)) {
			throw error;
		}
		// The service answered with an error, so the email didn't leave
		await store.releaseOutbound(sourceId);
		if (error.transient) {
			return retryIn(backoff(attempts));
		}

		return refuse(command, `the email service refused the message (\`${error.code.replace(/[^A-Z0-9_]/gi, "")}\`).`, app);
	}

	await store.setOutboundStatus(sourceId, "done", messageId);
	await store.addToThread(thread, messageId, false);
	await quietly(() => github.addReaction(command.id, "rocket"), app);
	await quietly(() => setReportStatus(thread.issueNumber, "waiting", app), app);
	if (showCopy) {
		const quoted = prepared.markdown.trim().split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
		await quietly(() => github.createComment(thread.issueNumber, `Sent to the reporter:\n\n${quoted}`), app);
	}
	app.log("outbound_sent", { comment: await ref(sourceId), attachments: mail.attachments.length });

	return ACK;
}

async function sendExisting(command: GitHubComment, args: string, thread: Thread, attempts: number, app: App): Promise<JobResult> {
	const targetId = parseCommentReference(args);
	if (null === targetId) {
		return refuse(command, "give the URL or the id of the comment to send.", app);
	}
	const target = await app.github.getComment(targetId);
	if (null === target || target.issueNumber !== command.issueNumber) {
		return refuse(command, "that comment is not on this issue.", app);
	}
	if (target.body.includes("<!-- list-to-issues:") || (await app.store.isMirroredComment(targetId))) {
		return refuse(command, "that comment is a mirrored email.", app);
	}
	// A draft may itself start with a command line: it isn't part of the email
	const draft = parseCommand(target.body, app.cfg.commandPrefix);

	return send(command, targetId, null === draft ? target.body : draft.rest, true, thread, attempts, app);
}

// Sends the configured acknowledgment, as the first answer of a thread.
async function acknowledge(command: GitHubComment, rest: string, thread: Thread, attempts: number, app: App): Promise<JobResult> {
	const { cfg, store } = app;
	if ("" === cfg.ackTemplate) {
		return refuse(command, "no acknowledgment template is configured.", app);
	}
	// A job that is delivered twice must not be mistaken for a second acknowledgment
	if (null === (await store.getOutbound(command.id)) && (await store.hasOutbound(thread.issueNumber))) {
		return refuse(command, `this thread was already answered. Use \`${cfg.commandPrefix}reply\` instead.`, app);
	}
	const text = [fill(cfg.ackTemplate, command.login, cfg).trim(), rest].filter((part) => "" !== part).join("\n\n");

	return send(command, command.id, text, false, thread, attempts, app, true);
}

async function setReporter(command: GitHubComment, args: string, thread: Thread, app: App): Promise<JobResult> {
	const addresses = args.split(/[\s,;]+/).filter((part) => "" !== part).map(normalizeAddress);
	if (0 === addresses.length || !addresses.every(isValidAddress)) {
		return refuse(command, "one of the addresses is not valid. Nothing changed.", app);
	}
	const [reporter, ...others] = addresses.map((address): Address => ({ address, name: "" }));
	await app.store.setReporter(thread.issueNumber, reporter!, uniqueAddresses(others, [reporter!.address]));
	await app.github.addReaction(command.id, "+1");

	return ACK;
}

async function listAttachments(command: GitHubComment, job: CommentJob, thread: Thread, app: App): Promise<JobResult> {
	const base = app.cfg.publicBaseUrl || job.origin;
	const sections: string[] = [];
	for (const [index, row] of (await app.store.listInbound(thread.issueNumber)).entries()) {
		const head = await app.raw.head(row.r2_key!);
		if (null === head) {
			continue;
		}
		const lines = [`- [raw message](${await createDownloadUrl(base, row.r2_key!, `message-${index + 1}.eml`, app)}) (${formatSize(head.size)})`];
		const listed = await app.raw.list({ prefix: attachmentPrefix(row.r2_key!), include: ["customMetadata"] });
		for (const [position, object] of listed.objects.entries()) {
			let name = `attachment-${position + 1}`;
			try {
				name = decodeURIComponent(object.customMetadata?.name ?? "") || name;
			} catch {
				// Keep the fallback name
			}
			lines.push(`- [${escapeMarkdown(name.replace(/\s+/g, " "))}](${await createDownloadUrl(base, object.key, name, app)}) (${formatSize(object.size)})`);
		}
		sections.push(`**Message ${index + 1}** (${row.created_at.slice(0, 10)})\n${lines.join("\n")}`);
	}

	const body = 0 === sections.length
		? "No file is left for this thread: the retention policy deleted them."
		: `Download links, valid for ${Math.max(1, Math.round(app.cfg.downloadLinkTtl / 60))} minutes:\n\n${sections.join("\n\n")}`;
	await app.github.createComment(thread.issueNumber, body);
	await quietly(() => app.github.addReaction(command.id, "+1"), app);

	return ACK;
}

async function markSpam(command: GitHubComment, thread: Thread, app: App): Promise<JobResult> {
	const { cfg, github, store } = app;
	await store.setSpam(thread.issueNumber);
	await store.setClosed(thread.issueNumber, app.now().toISOString());
	await github.setIssueState(thread.issueNumber, "closed", "not_planned");
	await github.ensureLabel(cfg.labelSpam);
	await github.addLabels(thread.issueNumber, [cfg.labelSpam]);
	await clearReportLabels(thread.issueNumber, app);
	await github.addReaction(command.id, "+1");

	return ACK;
}

// Answers a request for a bug bounty with the configured text, then ends the thread like
// "/close": the later messages are still mirrored, in case a real report follows.
async function answerBounty(command: GitHubComment, rest: string, thread: Thread, attempts: number, app: App): Promise<JobResult> {
	const { cfg, github, store } = app;
	if ("" === cfg.bountyTemplate) {
		return refuse(command, "no bug bounty template is configured.", app);
	}
	const text = [fill(cfg.bountyTemplate, command.login, cfg).trim(), rest].filter((part) => "" !== part).join("\n\n");
	const result = await send(command, command.id, text, false, thread, attempts, app, true);
	if ("done" !== (await store.getOutbound(command.id))?.status) {
		return result;
	}

	await store.setClosed(thread.issueNumber, app.now().toISOString());
	await clearReportLabels(thread.issueNumber, app);
	if ("" !== cfg.labelBounty) {
		await github.ensureLabel(cfg.labelBounty);
		await github.addLabels(thread.issueNumber, [cfg.labelBounty]);
	}
	await github.setIssueState(thread.issueNumber, "closed", "completed");

	return result;
}

// Ends a thread that needs nothing more: closed, and no label says that somebody waits.
// Unlike with "/spam", its later messages are still mirrored.
async function closeThread(command: GitHubComment, thread: Thread, app: App): Promise<JobResult> {
	await app.store.setClosed(thread.issueNumber, app.now().toISOString());
	await clearReportLabels(thread.issueNumber, app);
	await app.github.setIssueState(thread.issueNumber, "closed", "completed");
	await app.github.addReaction(command.id, "+1");

	return ACK;
}

export async function processOutbound(job: OutboundJob, attempts: number, app: App): Promise<JobResult> {
	const { cfg, github, store } = app;
	if ("issue_state" === job.type) {
		await store.setClosed(job.issue, job.closedAt);

		return ACK;
	}

	const thread = await store.getThread(job.issue);
	if (null === thread) {
		return ACK;
	}
	const comment = await github.getComment(job.commentId);
	if (null === comment || comment.isBot || comment.issueNumber !== job.issue) {
		return ACK;
	}

	let command: Command | null = parseCommand(comment.body, cfg.commandPrefix);
	if (null === command) {
		if ("reply" !== cfg.defaultOutboundMode) {
			return ACK;
		}
		command = { name: "reply", args: "", rest: comment.body.trim() };
	}

	// author_association isn't enough: ask for the real permission
	if (permissionRank(await github.getPermission(comment.login)) < permissionRank(cfg.minPermission)) {
		await github.addReaction(comment.id, "-1");
		app.log("outbound_denied", { comment: await ref(comment.id) });

		return ACK;
	}

	switch (command.name) {
		case "reply":
			return thread.spam
				? refuse(comment, "this thread is flagged as spam.", app)
				: send(comment, comment.id, command.rest, false, thread, attempts, app);
		case "send":
			return thread.spam
				? refuse(comment, "this thread is flagged as spam.", app)
				: sendExisting(comment, command.args, thread, attempts, app);
		case "ack":
			return thread.spam
				? refuse(comment, "this thread is flagged as spam.", app)
				: acknowledge(comment, command.rest, thread, attempts, app);
		case "bounty":
			return thread.spam
				? refuse(comment, "this thread is flagged as spam.", app)
				: answerBounty(comment, command.rest, thread, attempts, app);
		case "reporter":
			return setReporter(comment, command.args, thread, app);
		case "attachments":
			return listAttachments(comment, job, thread, app);
		case "close":
			return closeThread(comment, thread, app);
		case "spam":
			return markSpam(comment, thread, app);
	}
}
