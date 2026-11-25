export type CommandName = "reply" | "send" | "ack" | "reporter" | "attachments" | "close" | "spam" | "bounty";

export interface Command {
	name: CommandName;
	// What follows the command on its line
	args: string;
	// The comment without its first line
	rest: string;
}

const NAMES: CommandName[] = ["reply", "send", "ack", "reporter", "attachments", "close", "spam", "bounty"];

// A command is the first line of a comment: the prefix, a known name, then its arguments.
export function parseCommand(body: string, prefix: string): Command | null {
	const text = body.replace(/\r\n?/g, "\n").replace(/^\s+/, "");
	const end = text.indexOf("\n");
	const line = (-1 === end ? text : text.slice(0, end)).trim();
	if (!line.startsWith(prefix)) {
		return null;
	}
	const [word = "", ...args] = line.slice(prefix.length).split(/\s+/);
	const name = NAMES.find((candidate) => candidate === word.toLowerCase());
	if (undefined === name) {
		return null;
	}

	return { name, args: args.join(" ").trim(), rest: -1 === end ? "" : text.slice(end + 1).trim() };
}

// The id of the comment that "/send" points to: a comment URL or a bare id.
export function parseCommentReference(reference: string): number | null {
	const match = /#issuecomment-(\d{1,20})\b/.exec(reference) ?? /^(\d{1,20})$/.exec(reference.trim());

	return null === match ? null : Number(match[1]);
}
