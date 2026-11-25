import { describe, expect, it } from "vitest";
import { MailError } from "../src/app";
import { verifyEchoHeader } from "../src/echo";
import { buildMail, comment, deliver, drainInbound, drainOutbound, LIST, makeApp, receive, REPORTER, SENDER, type TestApp, webhook } from "./helpers";

async function thread(app: TestApp, options: Parameters<typeof buildMail>[0] = {}): Promise<void> {
	await receive(app, { messageId: "root@example.org", subject: "[list] A question", ...options });
}

function commentPayload(id: number, body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		action: "created",
		repository: { full_name: "example-org/example-repo" },
		installation: { id: 2 },
		issue: { number: 1 },
		comment: { id, body, user: { login: "maintainer", type: "User" } },
		sender: { login: "maintainer", type: "User" },
		...overrides,
	};
}

describe("webhook", () => {
	it("rejects a bad signature", async () => {
		const app = makeApp();
		const response = await webhook(app, "issue_comment", commentPayload(1, "/reply\nHi"), { signature: "sha256=" + "0".repeat(64) });

		expect(response.status).toBe(401);
		expect(app.outbound).toHaveLength(0);
	});

	it("rejects a signature made with another secret", async () => {
		const app = makeApp();
		const response = await webhook(app, "issue_comment", commentPayload(1, "/reply\nHi"), { secret: "another-secret" });

		expect(response.status).toBe(401);
	});

	it("ignores other repositories and installations", async () => {
		const app = makeApp();
		await webhook(app, "issue_comment", commentPayload(1, "/reply\nHi", { repository: { full_name: "example-org/other" } }));
		await webhook(app, "issue_comment", commentPayload(1, "/reply\nHi", { installation: { id: 99 } }));

		expect(app.outbound).toHaveLength(0);
	});

	it("ignores the comments of the App and of other bots", async () => {
		const app = makeApp();
		await webhook(app, "issue_comment", commentPayload(1, "/reply\nHi", { comment: { id: 1, body: "/reply\nHi", user: { login: "some[bot]", type: "Bot" } } }));
		await webhook(app, "issue_comment", commentPayload(1, "/reply\nHi", { sender: { login: "some[bot]", type: "Bot" } }));

		expect(app.outbound).toHaveLength(0);
	});

	it("doesn't queue a comment without a command", async () => {
		const app = makeApp();
		await webhook(app, "issue_comment", commentPayload(1, "Just a note for the team."));

		expect(app.outbound).toHaveLength(0);
	});
});

describe("/reply", () => {
	it("emails the comment to the reporter, threaded in their conversation", async () => {
		const app = makeApp();
		await thread(app, { to: `${LIST}, Colleague <colleague@example.org>` });
		const id = await comment(app, 1, "/reply\nThanks for the report.\n\nWe are looking into it.");

		expect(app.mailer.sent).toHaveLength(1);
		const mail = app.mailer.last();
		expect(mail.to).toEqual({ address: REPORTER, name: "Rita Reporter" });
		expect(mail.cc).toEqual([{ address: "colleague@example.org", name: "Colleague" }]);
		expect(mail.from).toEqual({ address: SENDER, name: "maintainer via Example List" });
		expect(mail.replyTo).toBe(LIST);
		expect(mail.subject).toBe("Re: A question");
		expect(mail.headers["In-Reply-To"]).toBe("<root@example.org>");
		expect(mail.headers.References).toBe("<root@example.org>");
		expect(await verifyEchoHeader(mail.headers["X-List-To-Issues"]!, app.cfg.hmacSecret)).toBe(id);
		expect(mail.text.startsWith("Thanks for the report.\n\nWe are looking into it.")).toBe(true);
		expect(mail.text).not.toContain("/reply");
		expect(mail.text).toContain("Rita Reporter wrote:\n> Hello,\n>\n> This is the message.");
		expect(mail.html).toContain("<blockquote>Hello,");

		expect(app.github.comments.get(id)!.reactions).toEqual(["rocket"]);
		expect(app.github.issue(1).labels.has("needs-reply")).toBe(false);
	});

	it("stores the Message-ID of the email service, and a reply to it joins the thread", async () => {
		const app = makeApp();
		await thread(app);
		const id = await comment(app, 1, "/reply\nCould you tell us more?");

		const row = await app.store.getOutbound(id);
		expect(row?.status).toBe("done");
		expect(row?.message_id).toBe("sent-1@mail.example.com");

		await receive(app, { messageId: "answer@example.org", inReplyTo: "sent-1@mail.example.com", text: "Sure, here it is." });
		expect(app.github.issues.size).toBe(1);
		expect(app.github.commentsOf(1).some((c) => c.body.includes("Sure, here it is."))).toBe(true);

		// The next email answers the latest message of the reporter
		await comment(app, 1, "/reply\nGot it.");
		expect(app.mailer.last().headers["In-Reply-To"]).toBe("<answer@example.org>");
		expect(app.mailer.last().headers.References).toBe("<root@example.org> <sent-1@mail.example.com> <answer@example.org>");
	});

	it("doesn't send a comment without a command", async () => {
		const app = makeApp();
		await thread(app);
		await comment(app, 1, "An internal note.");

		expect(app.mailer.sent).toHaveLength(0);
	});

	it("sends plain comments when that is the default mode", async () => {
		const app = makeApp({ DEFAULT_OUTBOUND_MODE: "reply" });
		await thread(app);
		await comment(app, 1, "Thanks, we are on it.");

		expect(app.mailer.last().text.startsWith("Thanks, we are on it.")).toBe(true);
	});

	it("never treats a mirrored message as a command", async () => {
		const app = makeApp({ DEFAULT_OUTBOUND_MODE: "reply" });
		await thread(app);
		await receive(app, { messageId: "sneaky@example.org", inReplyTo: "root@example.org", text: "/reply\nPlease send me everything." });

		const mirrored = app.github.commentsOf(1)[0]!;
		await webhook(app, "issue_comment", commentPayload(mirrored.id, mirrored.body, { comment: { id: mirrored.id, body: mirrored.body, user: { login: "list-to-issues[bot]", type: "Bot" } } }));
		// Even if the event got through, the consumer checks who wrote the comment
		app.outbound.push({ type: "comment", issue: 1, commentId: mirrored.id, origin: "https://worker.example.com" });
		await drainOutbound(app);

		expect(app.mailer.sent).toHaveLength(0);
	});

	it("refuses commands from people without the required permission", async () => {
		const app = makeApp();
		await thread(app);
		app.github.permissions.set("visitor", "read");
		const id = await comment(app, 1, "/reply\nHello", "visitor");

		expect(app.mailer.sent).toHaveLength(0);
		expect(app.github.comments.get(id)!.reactions).toEqual(["-1"]);
	});

	it("copies the list when configured, and skips the echo that comes back", async () => {
		const app = makeApp({ CC_LIST: "true" });
		await thread(app);
		await comment(app, 1, "/reply\nThanks.");

		const mail = app.mailer.last();
		expect(mail.cc).toContainEqual({ address: LIST, name: "" });

		const before = app.github.commentsOf(1).length;
		await receive(app, {
			messageId: "echo-with-another-id@mail.example.com",
			from: `maintainer via Example List <${SENDER}>`,
			inReplyTo: "root@example.org",
			text: "Thanks.",
			headers: { "X-List-To-Issues": mail.headers["X-List-To-Issues"]! },
		});
		expect(app.github.commentsOf(1)).toHaveLength(before);
	});

	it("doesn't trust an echo header that isn't signed by us", async () => {
		const app = makeApp();
		await thread(app);
		await receive(app, { messageId: "fake-echo@example.org", inReplyTo: "root@example.org", text: "Not an echo.", headers: { "X-List-To-Issues": `1000.${"a".repeat(64)}` } });

		expect(app.github.commentsOf(1)[0]!.body).toContain("Not an echo.");
	});

	it("protects headers against injection through names and subjects", async () => {
		const app = makeApp();
		await receive(app, { messageId: "root@example.org", subject: "A question" });
		await app.store.setReporter(1, { address: REPORTER, name: "Rita\r\nBcc: victim@example.net" }, []);
		const stored = await app.store.getThread(1);
		await app.store.createThread({ issueNumber: 2, rootMessageId: "other@example.org", subject: "Hello\r\nBcc: victim@example.net", reporter: stored!.reporter, extraRecipients: [] }, "2026-11-18T10:00:00Z");
		app.github.issues.set(2, { title: "x", body: "", labels: new Set(), state: "open", reason: null });
		await comment(app, 2, "/reply\nHi", "evil\r\nBcc: victim@example.net");

		const mail = app.mailer.last();
		for (const value of [mail.subject, mail.from.name, ...Object.values(mail.headers)]) {
			expect(value).not.toMatch(/[\r\n]/);
		}
	});

	it("attaches the files uploaded into the comment", async () => {
		const app = makeApp();
		await thread(app);
		const url = "https://github.com/user-attachments/files/123/patch.diff";
		app.github.uploads.set(url, { filename: "patch.diff", contentType: "text/x-diff", content: new TextEncoder().encode("--- a\n+++ b\n") });
		await comment(app, 1, `/reply\nHere is the fix: [patch.diff](${url})`);

		const mail = app.mailer.last();
		expect(mail.attachments).toHaveLength(1);
		expect(mail.attachments[0]!.filename).toBe("patch.diff");
		expect(mail.text).toContain("Here is the fix: patch.diff (attached)");
		expect(mail.text).not.toContain("github.com");
		expect(mail.html).not.toContain("github.com");
	});

	it("doesn't send when an uploaded file can't be fetched", async () => {
		const app = makeApp();
		await thread(app);
		const id = await comment(app, 1, "/reply\nSee ![screenshot](https://github.com/user-attachments/assets/0000-1111)");

		expect(app.mailer.sent).toHaveLength(0);
		expect(app.github.comments.get(id)!.reactions).toEqual(["confused"]);
		expect(app.github.commentsOf(1).at(-1)!.body).toContain("Not sent: a file uploaded in the comment could not be fetched");
	});

	it("doesn't send links to the repository", async () => {
		const app = makeApp();
		await thread(app);
		await comment(app, 1, "/reply\nSee https://github.com/example-org/example-repo/issues/4 for details.");

		expect(app.mailer.sent).toHaveLength(0);
		expect(app.github.commentsOf(1).at(-1)!.body).toContain("links to this repository");
	});
});

describe("sending is at most once", () => {
	it("doesn't send again when the job is delivered twice", async () => {
		const app = makeApp();
		await thread(app);
		const id = await comment(app, 1, "/reply\nThanks.");
		app.outbound.push({ type: "comment", issue: 1, commentId: id, origin: "https://worker.example.com" });
		await drainOutbound(app);

		expect(app.mailer.sent).toHaveLength(1);
	});

	it("reports an unknown status instead of sending again after an interrupted attempt", async () => {
		const app = makeApp();
		await thread(app);
		app.github.permissions.set("maintainer", "write");
		const id = app.github.userComment(1, "maintainer", "/reply\nThanks.");
		// An earlier attempt claimed the comment, then died before the email service answered
		await app.store.claimOutbound(id, 1, "2026-11-18T10:00:00Z");
		app.outbound.push({ type: "comment", issue: 1, commentId: id, origin: "https://worker.example.com" });
		await drainOutbound(app);

		expect(app.mailer.sent).toHaveLength(0);
		expect((await app.store.getOutbound(id))?.status).toBe("unknown");
		expect(app.github.comments.get(id)!.reactions).toEqual(["confused"]);
		expect(app.github.commentsOf(1).at(-1)!.body).toContain("the status of this email is unknown");

		// The same job again stays silent, and an explicit /send retries
		app.outbound.push({ type: "comment", issue: 1, commentId: id, origin: "https://worker.example.com" });
		await drainOutbound(app);
		expect(app.mailer.sent).toHaveLength(0);

		await comment(app, 1, `/send ${id}`);
		expect(app.mailer.sent).toHaveLength(1);
		expect((await app.store.getOutbound(id))?.status).toBe("done");
	});

	it("retries when the email service is temporarily unavailable", async () => {
		const app = makeApp();
		await thread(app);
		app.mailer.failNext(new MailError("E_RATE_LIMIT_EXCEEDED", true));
		const id = await comment(app, 1, "/reply\nThanks.");

		expect(app.mailer.sent).toHaveLength(1);
		expect(app.github.comments.get(id)!.reactions).toEqual(["rocket"]);
	});

	it("reports a permanent failure of the email service", async () => {
		const app = makeApp();
		await thread(app);
		app.mailer.failNext(new MailError("E_RECIPIENT_SUPPRESSED", false));
		const id = await comment(app, 1, "/reply\nThanks.");

		expect(app.mailer.sent).toHaveLength(0);
		expect(app.github.comments.get(id)!.reactions).toEqual(["confused"]);
		expect(app.github.commentsOf(1).at(-1)!.body).toContain("`E_RECIPIENT_SUPPRESSED`");
		expect(await app.store.getOutbound(id)).toBeNull();
	});
});

describe("/send", () => {
	it("emails an existing comment, whoever wrote it", async () => {
		const app = makeApp();
		await thread(app);
		const draft = app.github.userComment(1, "an-assistant", "Thanks for the report, a fix is on its way.");
		const command = await comment(app, 1, `/send https://github.com/example-org/example-repo/issues/1#issuecomment-${draft}`);

		const mail = app.mailer.last();
		expect(mail.text.startsWith("Thanks for the report, a fix is on its way.")).toBe(true);
		expect(mail.from.name).toBe("maintainer via Example List");
		expect(app.github.comments.get(command)!.reactions).toEqual(["rocket"]);
		expect((await app.store.getOutbound(draft))?.status).toBe("done");
	});

	it("refuses to send the same comment twice", async () => {
		const app = makeApp();
		await thread(app);
		const draft = app.github.userComment(1, "an-assistant", "The draft.");
		await comment(app, 1, `/send ${draft}`);
		const second = await comment(app, 1, `/send ${draft}`);

		expect(app.mailer.sent).toHaveLength(1);
		expect(app.github.comments.get(second)!.reactions).toEqual(["confused"]);
		expect(app.github.commentsOf(1).at(-1)!.body).toContain("already sent");
	});

	it("refuses unknown comments, comments of other issues and mirrored emails", async () => {
		const app = makeApp();
		await thread(app);
		await receive(app, { messageId: "other-root@example.org", subject: "Another thread" });
		await receive(app, { messageId: "reply@example.org", inReplyTo: "root@example.org", text: "A mirrored reply." });
		const elsewhere = app.github.userComment(2, "an-assistant", "A draft on another issue.");
		const mirrored = app.github.commentsOf(1)[0]!.id;

		for (const reference of ["999999", String(elsewhere), String(mirrored), "not-a-reference"]) {
			await comment(app, 1, `/send ${reference}`);
		}

		expect(app.mailer.sent).toHaveLength(0);
	});
});

describe("/ack", () => {
	const template = { ACK_TEMPLATE: "Hello,\n\nWe received your report.\n\n{commenter}, for {label}" };

	it("sends the configured acknowledgment and shows it on the issue", async () => {
		const app = makeApp(template);
		await thread(app);
		const id = await comment(app, 1, "/ack");

		const mail = app.mailer.last();
		expect(mail.to.address).toBe(REPORTER);
		expect(mail.subject).toBe("Re: A question");
		expect(mail.headers["In-Reply-To"]).toBe("<root@example.org>");
		expect(mail.text.startsWith("Hello,\n\nWe received your report.\n\nmaintainer, for Example List")).toBe(true);
		expect(app.github.comments.get(id)!.reactions).toEqual(["rocket"]);
		expect(app.github.commentsOf(1).at(-1)!.body).toBe("Sent to the reporter:\n\n> Hello,\n>\n> We received your report.\n>\n> maintainer, for Example List");
		expect(app.github.issue(1).labels.has("needs-reply")).toBe(false);
	});

	it("adds the text written below the command", async () => {
		const app = makeApp(template);
		await thread(app);
		await comment(app, 1, "/ack\nWe will come back to you next week.");

		expect(app.mailer.last().text).toContain("maintainer, for Example List\n\nWe will come back to you next week.");
	});

	it("is the first answer of a thread only", async () => {
		const app = makeApp(template);
		await thread(app);
		const first = await comment(app, 1, "/ack");
		const second = await comment(app, 1, "/ack");

		expect(app.mailer.sent).toHaveLength(1);
		expect(app.github.comments.get(second)!.reactions).toEqual(["confused"]);
		expect(app.github.commentsOf(1).at(-1)!.body).toContain("already answered");

		// The same job delivered twice is not a second acknowledgment
		const comments = app.github.commentsOf(1).length;
		app.outbound.push({ type: "comment", issue: 1, commentId: first, origin: "https://worker.example.com" });
		await drainOutbound(app);
		expect(app.mailer.sent).toHaveLength(1);
		expect(app.github.commentsOf(1)).toHaveLength(comments);
	});

	it("needs a template", async () => {
		const app = makeApp();
		await thread(app);
		const id = await comment(app, 1, "/ack");

		expect(app.mailer.sent).toHaveLength(0);
		expect(app.github.comments.get(id)!.reactions).toEqual(["confused"]);
		expect(app.github.commentsOf(1).at(-1)!.body).toContain("no acknowledgment template is configured");
	});
});

describe("/reporter", () => {
	it("changes who receives the emails", async () => {
		const app = makeApp();
		await thread(app);
		const id = await comment(app, 1, "/reporter Real.Reporter@example.net, <second@example.net>");

		expect(app.mailer.sent).toHaveLength(0);
		expect(app.github.comments.get(id)!.reactions).toEqual(["+1"]);
		const stored = await app.store.getThread(1);
		expect(stored?.reporter.address).toBe("real.reporter@example.net");
		expect(stored?.extraRecipients).toEqual([{ address: "second@example.net", name: "" }]);

		await comment(app, 1, "/reply\nHello");
		expect(app.mailer.last().to.address).toBe("real.reporter@example.net");
		expect(app.mailer.last().cc).toEqual([{ address: "second@example.net", name: "" }]);
	});

	it("refuses an invalid address", async () => {
		const app = makeApp();
		await thread(app);
		for (const address of ["not-an-address", "a@b", "valid@example.net, broken@", ""]) {
			const id = await comment(app, 1, `/reporter ${address}`);
			expect(app.github.comments.get(id)!.reactions).toEqual(["confused"]);
		}

		expect((await app.store.getThread(1))?.reporter.address).toBe(REPORTER);
	});

	it("only reads addresses on the command line", async () => {
		const app = makeApp();
		await thread(app);
		await comment(app, 1, "/reporter x@example.org\r\nBcc: victim@example.net");

		const stored = await app.store.getThread(1);
		expect(stored?.reporter.address).toBe("x@example.org");
		expect(stored?.extraRecipients).toEqual([]);
	});
});

describe("/close", () => {
	it("closes the thread without silencing it", async () => {
		const app = makeApp({ LABEL_ANSWER_OWED: "answer-owed" });
		await thread(app);
		expect([...app.github.issue(1).labels]).toEqual(["via-email", "needs-reply", "answer-owed"]);

		const id = await comment(app, 1, "/close");
		const issue = app.github.issue(1);
		expect(issue.state).toBe("closed");
		expect(issue.reason).toBe("completed");
		expect([...issue.labels]).toEqual(["via-email"]);
		expect(app.github.comments.get(id)!.reactions).toEqual(["+1"]);
		expect((await app.store.getThread(1))?.closedAt).toBe("2026-11-18T10:00:00.000Z");
		expect((await app.store.getThread(1))?.spam).toBe(false);

		// A later message is mirrored, and the issue comes back
		await receive(app, { messageId: "later@example.org", inReplyTo: "root@example.org", text: "One more thing." });
		expect(app.github.commentsOf(1).some((c) => c.body.includes("One more thing."))).toBe(true);
		expect(issue.state).toBe("open");
		expect([...issue.labels]).toEqual(["via-email", "needs-reply"]);
	});
});

describe("/bounty", () => {
	const template = { BOUNTY_TEMPLATE: "Hello,\n\nWe don't pay rewards.\n\n{commenter}, for {label}", LABEL_ANSWER_OWED: "answer-owed" };

	it("sends the configured answer and closes the thread without silencing it", async () => {
		const app = makeApp({ ...template, LABEL_BOUNTY: "bounty" });
		await thread(app);
		const id = await comment(app, 1, "/bounty");

		const mail = app.mailer.last();
		expect(mail.to.address).toBe(REPORTER);
		expect(mail.headers["In-Reply-To"]).toBe("<root@example.org>");
		expect(mail.text.startsWith("Hello,\n\nWe don't pay rewards.\n\nmaintainer, for Example List")).toBe(true);
		expect(app.github.comments.get(id)!.reactions).toEqual(["rocket"]);
		expect(app.github.commentsOf(1).at(-1)!.body).toBe("Sent to the reporter:\n\n> Hello,\n>\n> We don't pay rewards.\n>\n> maintainer, for Example List");

		const issue = app.github.issue(1);
		expect(issue.state).toBe("closed");
		expect(issue.reason).toBe("completed");
		expect([...issue.labels]).toEqual(["via-email", "bounty"]);
		expect((await app.store.getThread(1))?.spam).toBe(false);

		// A real report may follow: it is mirrored, and the issue comes back
		await receive(app, { messageId: "later@example.org", inReplyTo: "root@example.org", text: "Here is a finding." });
		expect(app.github.commentsOf(1).some((c) => c.body.includes("Here is a finding."))).toBe(true);
		expect(issue.state).toBe("open");
	});

	it("adds the text written below the command", async () => {
		const app = makeApp(template);
		await thread(app);
		await comment(app, 1, "/bounty\nThanks for your interest.");

		expect(app.mailer.last().text).toContain("maintainer, for Example List\n\nThanks for your interest.");
		expect([...app.github.issue(1).labels]).toEqual(["via-email"]);
	});

	it("sends once when the job is delivered twice", async () => {
		const app = makeApp(template);
		await thread(app);
		const id = await comment(app, 1, "/bounty");
		app.outbound.push({ type: "comment", issue: 1, commentId: id, origin: "https://worker.example.com" });
		await drainOutbound(app);

		expect(app.mailer.sent).toHaveLength(1);
	});

	it("keeps the thread open when the email is refused", async () => {
		const app = makeApp(template);
		await thread(app);
		app.mailer.failNext(new MailError("E_RECIPIENT_SUPPRESSED", false));
		const id = await comment(app, 1, "/bounty");

		expect(app.github.comments.get(id)!.reactions).toEqual(["confused"]);
		expect(app.github.issue(1).state).toBe("open");
		expect([...app.github.issue(1).labels]).toEqual(["via-email", "needs-reply", "answer-owed"]);
	});

	it("needs a template", async () => {
		const app = makeApp();
		await thread(app);
		const id = await comment(app, 1, "/bounty");

		expect(app.mailer.sent).toHaveLength(0);
		expect(app.github.comments.get(id)!.reactions).toEqual(["confused"]);
		expect(app.github.commentsOf(1).at(-1)!.body).toContain("no bug bounty template is configured");
		expect(app.github.issue(1).state).toBe("open");
	});
});

describe("/spam", () => {
	it("closes, labels and silences the thread", async () => {
		const app = makeApp({ LABEL_ANSWER_OWED: "answer-owed" });
		await thread(app);
		const id = await comment(app, 1, "/spam");

		const issue = app.github.issue(1);
		expect(issue.state).toBe("closed");
		expect(issue.reason).toBe("not_planned");
		expect([...issue.labels]).toEqual(["via-email", "spam"]);
		expect(app.github.comments.get(id)!.reactions).toEqual(["+1"]);

		const before = app.github.commentsOf(1).length;
		await receive(app, { messageId: "more-spam@example.org", inReplyTo: "root@example.org", text: "Buy now." });
		expect(app.github.commentsOf(1)).toHaveLength(before);
		expect(issue.state).toBe("closed");

		await comment(app, 1, "/reply\nHello");
		expect(app.mailer.sent).toHaveLength(0);
	});
});

describe("issue state", () => {
	it("records when an issue is closed and reopened", async () => {
		const app = makeApp();
		await thread(app);
		const payload = { repository: { full_name: "example-org/example-repo" }, installation: { id: 2 }, sender: { login: "list-to-issues[bot]", type: "Bot" } };

		await webhook(app, "issues", { ...payload, action: "closed", issue: { number: 1, closed_at: "2026-11-18T12:00:00Z" } });
		await drainOutbound(app);
		expect((await app.store.getThread(1))?.closedAt).toBe("2026-11-18T12:00:00Z");

		await webhook(app, "issues", { ...payload, action: "reopened", issue: { number: 1, closed_at: null } });
		await drainOutbound(app);
		expect((await app.store.getThread(1))?.closedAt).toBeNull();
	});
});

describe("direct replies", () => {
	async function sentThread(app: TestApp): Promise<void> {
		await thread(app);
		await comment(app, 1, "/reply\nCould you tell us more?");
	}

	it("accepts a reply to our address that refers to one of our emails", async () => {
		const app = makeApp();
		await sentThread(app);
		const delivery = await deliver(app, buildMail({ messageId: "direct@example.org", inReplyTo: "sent-1@mail.example.com", text: "Straight to you.", listHeaders: false }), { from: REPORTER, to: SENDER });
		await drainInbound(app);

		expect(delivery.rejected).toBeNull();
		expect(delivery.forwarded).toEqual([]);
		expect(app.github.commentsOf(1).some((c) => c.body.includes("Straight to you."))).toBe(true);
	});

	it("rejects an unknown reference or another sender", async () => {
		const app = makeApp();
		await sentThread(app);
		const unknown = await deliver(app, buildMail({ inReplyTo: "unknown@example.net", listHeaders: false }), { from: REPORTER, to: SENDER });
		const stranger = await deliver(app, buildMail({ from: "stranger@example.net", inReplyTo: "sent-1@mail.example.com", listHeaders: false }), { from: "stranger@example.net", to: SENDER });
		const inboundOnly = await deliver(app, buildMail({ inReplyTo: "root@example.org", listHeaders: false }), { from: REPORTER, to: SENDER });

		expect(unknown.rejected).not.toBeNull();
		expect(stranger.rejected).not.toBeNull();
		expect(inboundOnly.rejected).not.toBeNull();
		expect(app.inbound).toHaveLength(0);
	});

	it("forwards a direct reply to the list when configured, without mirroring it twice", async () => {
		const app = makeApp({ FORWARD_DIRECT_REPLIES: "true" });
		await sentThread(app);
		const raw = buildMail({ messageId: "direct@example.org", inReplyTo: "sent-1@mail.example.com", text: "Straight to you.", listHeaders: false });
		const delivery = await deliver(app, raw, { from: REPORTER, to: SENDER });
		expect(delivery.forwarded).toEqual([LIST]);

		// The list then delivers its own copy
		await deliver(app, buildMail({ messageId: "direct@example.org", inReplyTo: "sent-1@mail.example.com", text: "Straight to you." }));
		await drainInbound(app);

		expect(app.github.commentsOf(1).filter((c) => c.body.includes("Straight to you."))).toHaveLength(1);
	});
});

describe("round trip", () => {
	it("goes from the list to an issue, back to the reporter, and to the same issue again", async () => {
		const app = makeApp();
		await receive(app, { messageId: "report@example.org", subject: "[list] Something is wrong", text: "I found a problem." });
		expect(app.github.issue(1).title).toBe("Something is wrong");

		await comment(app, 1, "/reply\nThanks. Which version do you use?");
		const sent = app.mailer.last();
		expect(sent.to.address).toBe(REPORTER);
		expect(sent.subject).toBe("Re: Something is wrong");

		await receive(app, {
			messageId: "answer@example.org",
			subject: "Re: [list] Something is wrong",
			inReplyTo: "sent-1@mail.example.com",
			references: ["report@example.org", "sent-1@mail.example.com"],
			text: "Version 4.2.\n\nOn Wed, 18 Nov 2026 10:00:00 UTC, maintainer via Example List wrote:\n> Thanks. Which version do you use?",
		});

		expect(app.github.issues.size).toBe(1);
		const answer = app.github.commentsOf(1).find((c) => c.body.includes("Version 4.2."))!;
		expect(answer.body.slice(0, answer.body.indexOf("<details>"))).not.toContain("Which version do you use?");
		expect(app.github.issue(1).labels.has("needs-reply")).toBe(true);
	});
});
