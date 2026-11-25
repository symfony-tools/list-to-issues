import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { InboundJob, OutboundJob } from "../src/jobs";
import { parseCommand, parseCommentReference } from "../src/outbound/commands";
import { cleanSubject, htmlToText, stripQuotedReply } from "../src/inbound/body";
import { escapeMarkdown, fence } from "../src/markdown";
import { buildMail, testEnv } from "./helpers";

type Job = InboundJob | OutboundJob;

function batch(jobs: Job[], attempts = 1): { batch: MessageBatch<Job>; acked: Job[]; retried: { job: Job; delaySeconds?: number }[] } {
	const acked: Job[] = [];
	const retried: { job: Job; delaySeconds?: number }[] = [];
	const messages = jobs.map((job, index) => ({
		id: String(index),
		timestamp: new Date(),
		body: job,
		attempts,
		ack: () => void acked.push(job),
		retry: (options?: QueueRetryOptions) => void retried.push({ job, delaySeconds: options?.delaySeconds }),
	}));

	return { batch: { queue: "list-to-issues-inbound", messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<Job>, acked, retried };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Worker entry point", () => {
	it("answers 404 outside of its two routes", async () => {
		const response = await worker.fetch(new Request("https://worker.example.com/"), testEnv());

		expect(response.status).toBe(404);
	});

	it("checks the signature of webhooks", async () => {
		const response = await worker.fetch(new Request("https://worker.example.com/github/webhook", { method: "POST", body: "{}" }), testEnv());

		expect(response.status).toBe(401);
	});

	it("checks the token of downloads", async () => {
		const response = await worker.fetch(new Request("https://worker.example.com/download/not-a-token"), testEnv());

		expect(response.status).toBe(403);
	});

	it("rejects an email that didn't come through the list", async () => {
		let rejected = "";
		const raw = new TextEncoder().encode(buildMail());
		await worker.email({
			from: "someone@example.net",
			to: "bot@mail.example.com",
			headers: new Headers({ "list-id": "<list.example.com>" }),
			raw: new Response(raw).body!,
			rawSize: raw.byteLength,
			setReject: (reason: string) => void (rejected = reason),
			forward: async () => ({ messageId: "" }),
			reply: async () => ({ messageId: "" }),
		} as unknown as ForwardableEmailMessage, testEnv());

		expect(rejected).not.toBe("");
	});

	it("acknowledges jobs that are done or have nothing to do", async () => {
		const { batch: messages, acked, retried } = batch([
			{ type: "email", r2Key: "raw/2026/11/missing.eml" },
			{ type: "issue_state", issue: 1, closedAt: null },
			{ type: "comment", issue: 404, commentId: 1, origin: "https://worker.example.com" },
		]);
		await worker.queue(messages, testEnv());

		expect(acked).toHaveLength(3);
		expect(retried).toHaveLength(0);
	});

	it("retries a job when GitHub can't be reached, with the delay that GitHub asks for", async () => {
		await env.RAW.put("raw/2026/11/a.eml", buildMail());
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 503, headers: { "retry-after": "42" } }));
		const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
		const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
		const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;

		const { batch: messages, acked, retried } = batch([{ type: "email", r2Key: "raw/2026/11/a.eml" }], 2);
		await worker.queue(messages, testEnv({ GITHUB_APP_PRIVATE_KEY: pem }));

		expect(acked).toHaveLength(0);
		expect(retried).toEqual([{ job: { type: "email", r2Key: "raw/2026/11/a.eml" }, delaySeconds: 42 }]);
	});

	it("retries with a growing delay when the configuration is broken", async () => {
		await env.RAW.put("raw/2026/11/b.eml", buildMail());
		const { batch: messages, retried } = batch([{ type: "email", r2Key: "raw/2026/11/b.eml" }], 3);
		// The placeholder key of the tests isn't a key
		await worker.queue(messages, testEnv());

		expect(retried).toHaveLength(1);
		expect(retried[0]!.delaySeconds).toBe(60);
	});

	it("runs the scheduled cleanup", async () => {
		await expect(worker.scheduled({ cron: "17 3 * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, testEnv({ RETENTION_DAYS: "30" }))).resolves.toBeUndefined();
	});
});

describe("commands", () => {
	it("reads a command on the first line only", () => {
		expect(parseCommand("/reply\nHello\nthere", "/")).toEqual({ name: "reply", args: "", rest: "Hello\nthere" });
		expect(parseCommand("  \n/Send  https://example.com/x#issuecomment-12  \n", "/")).toEqual({ name: "send", args: "https://example.com/x#issuecomment-12", rest: "" });
		expect(parseCommand("!reporter a@example.org", "!")).toEqual({ name: "reporter", args: "a@example.org", rest: "" });
		expect(parseCommand("Hello\n/reply", "/")).toBeNull();
		expect(parseCommand("/replying to you", "/")).toBeNull();
		expect(parseCommand("/ack", "/")).toEqual({ name: "ack", args: "", rest: "" });
		expect(parseCommand("/close", "/")).toEqual({ name: "close", args: "", rest: "" });
		expect(parseCommand("/bounty\nThanks", "/")).toEqual({ name: "bounty", args: "", rest: "Thanks" });
		expect(parseCommand("/unknown", "/")).toBeNull();
		expect(parseCommand("", "/")).toBeNull();
	});

	it("reads a comment reference", () => {
		expect(parseCommentReference("https://github.com/example-org/example-repo/issues/1#issuecomment-123456")).toBe(123456);
		expect(parseCommentReference(" 42 ")).toBe(42);
		expect(parseCommentReference("issue 42")).toBeNull();
		expect(parseCommentReference("")).toBeNull();
	});
});

describe("text helpers", () => {
	it("strips the quoted history in several shapes", () => {
		expect(stripQuotedReply("Sure.\n\nOn Mon, 2 Nov 2026 at 10:00, Someone\n<someone@example.com> wrote:\n> Hi")).toBe("Sure.");
		expect(stripQuotedReply("Oui.\n\nLe lun. 2 nov. 2026 à 10:00, Quelqu'un <q@example.com> a écrit :\n> Bonjour")).toBe("Oui.");
		expect(stripQuotedReply("Done.\n\n-----Original Message-----\nFrom: Someone\nSubject: x\n\nHi")).toBe("Done.");
		expect(stripQuotedReply("Done.\n\nFrom: Someone <s@example.com>\nSent: Monday\nTo: List\nSubject: x\n\nHi")).toBe("Done.");
		expect(stripQuotedReply("Thanks!\n\n> Hi\n> there\n")).toBe("Thanks!");
	});

	it("keeps inline answers and messages that are only a quote", () => {
		const inline = "> Which version?\n4.2\n> Which system?\nLinux";
		expect(stripQuotedReply(inline)).toBe(inline);
		expect(stripQuotedReply("> Only a quote")).toBe("> Only a quote");
		expect(stripQuotedReply("On Monday I wrote: nothing special.\nBye")).toBe("On Monday I wrote: nothing special.\nBye");
	});

	it("cleans subjects", () => {
		expect(cleanSubject("[list] Re: [list] AW: Fwd: Hello  world", "[list]")).toBe("Hello world");
		expect(cleanSubject("Re[2]: TR: Bonjour", "")).toBe("Bonjour");
		expect(cleanSubject("Regarding the report", "[list]")).toBe("Regarding the report");
		expect(cleanSubject("Line\r\nbreak", "")).toBe("Line break");
	});

	it("converts HTML to text", () => {
		expect(htmlToText("<div>One</div><div>Two &lt;b&gt; &#233; &#x41;</div><ul><li>a</li><li>b</li></ul><script>alert(1)</script>")).toBe("One\n\nTwo <b> é A\n\n- a\n- b");
	});

	it("renders plain text literally", () => {
		expect(escapeMarkdown("1. one\n- two\n* three\n> four\n---\n\ttabbed")).toBe("1\\. one\n\\- two\n\\* three\n&gt; four\n\\---\n&nbsp;&nbsp;&nbsp;&nbsp;tabbed");
		expect(escapeMarkdown("[link](https://example.com/a_b) and __bold__")).toBe("\\[link\\](https://example.com/a_b) and \\_\\_bold\\_\\_");
		expect(fence("a ``` b ```` c")).toBe("`````\na ``` b ```` c\n`````");
	});
});
