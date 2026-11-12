import type { AuditIssue } from "#/lib/api.ts";
import { parentPath } from "#/lib/fs-path.ts";

export type IssueKind = AuditIssue["kind"];

export interface FolderSummary {
	/** Issues inside, counting every file below. */
	count: number;
	/** Files with at least one issue that can be fixed automatically. */
	fixable: number;
	/** Issues per kind. */
	kinds: Readonly<Partial<Record<IssueKind, number>>>;
	/** Issues that need the user to type something (open the file's card to do it). */
	input: number;
}

export interface IssueIndex {
	/** Issues of each file. */
	byPath: ReadonlyMap<string, readonly AuditIssue[]>;
	/** Issue totals of each folder, counting everything inside it. */
	folders: ReadonlyMap<string, FolderSummary>;
}

function addToFolder(
	folders: Map<string, FolderSummary>,
	dir: string,
	list: readonly AuditIssue[],
): void {
	const prev = folders.get(dir) ?? { count: 0, fixable: 0, kinds: {}, input: 0 };
	const kinds: Partial<Record<IssueKind, number>> = { ...prev.kinds };
	for (const i of list) {
		kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
	}
	folders.set(dir, {
		count: prev.count + list.length,
		fixable: prev.fixable + (list.some((i) => i.fixable) ? 1 : 0),
		kinds,
		input: prev.input + list.filter((i) => i.place !== null).length,
	});
}

/** Groups findings by file and rolls them up to every folder between the file and `root`. */
export function indexIssues(root: string, issues: readonly AuditIssue[]): IssueIndex {
	const byPath = new Map<string, AuditIssue[]>();
	for (const issue of issues) {
		byPath.set(issue.path, [...(byPath.get(issue.path) ?? []), issue]);
	}
	const folders = new Map<string, FolderSummary>();
	for (const [path, list] of byPath) {
		let dir = parentPath(path);
		// `parentPath` of a top-level path is the separator itself, so stop on length too.
		while (dir.length >= root.length && dir.startsWith(root)) {
			addToFolder(folders, dir, list);
			if (dir === root) {
				break;
			}
			dir = parentPath(dir);
		}
	}
	return { byPath, folders };
}

export interface Card {
	title: string | null;
	/** One line per problem. */
	lines: string[];
	/** Files that can be fixed automatically. */
	fixable: number;
	fixLabel: string;
	/** Known artist/album for the "where does this go" form, when the file needs one. */
	form: PlaceDefaults | null;
}

export interface PlaceDefaults {
	artist: string | null;
	album: string | null;
}

/** What the warning popover for a file or folder says. `null` when it has no issues. */
export function cardFor(path: string, isDir: boolean, index: IssueIndex): Card | null {
	if (isDir) {
		const f = index.folders.get(path);
		return f === undefined
			? null
			: {
					title: `${f.count} ${f.count === 1 ? "issue" : "issues"} inside`,
					lines: [
						...kindLines(f.kinds),
						...(f.input > 0 ? [`${f.input} need details from you (open the folder, click ⚠)`] : []),
					],
					fixable: f.fixable,
					fixLabel: `Fix all (${f.fixable})`,
					form: null,
				};
	}
	const list = index.byPath.get(path) ?? [];
	if (list.length === 0) {
		return null;
	}
	return {
		title: null,
		lines: list.map((i) => (i.fixable ? i.message : `${i.message} (needs manual attention)`)),
		fixable: Number(list.some((i) => i.fixable)),
		fixLabel: "Fix",
		form: list.find((i) => i.place !== null)?.place ?? null,
	};
}

function isUnder(path: string, ancestor: string): boolean {
	return path === ancestor || path.startsWith(`${ancestor}/`) || path.startsWith(`${ancestor}\\`);
}

/** Files with at least one fixable issue at or under any of `scopes` (all files when omitted). */
export function fixablePaths(issues: readonly AuditIssue[], scopes?: readonly string[]): string[] {
	const found = new Set<string>();
	for (const i of issues) {
		if (i.fixable && (scopes === undefined || scopes.some((s) => isUnder(i.path, s)))) {
			found.add(i.path);
		}
	}
	return [...found];
}

const KIND_LABEL: Record<IssueKind, (n: number) => string> = {
	notMp3: (n) => `Convert ${n} file${n === 1 ? "" : "s"} to MP3 (originals go to the Trash)`,
	tagVersion: (n) => `Rewrite tags as ID3v2.3 on ${n} file${n === 1 ? "" : "s"}`,
	misplaced: (n) => `Move ${n} file${n === 1 ? "" : "s"} into Artist/Album folders`,
};

/** One line per kind of fix about to run, for the confirmation prompt. */
export function describeFixes(issues: readonly AuditIssue[], paths: readonly string[]): string[] {
	const wanted = new Set(paths);
	const counts = new Map<AuditIssue["kind"], number>();
	for (const i of issues) {
		if (i.fixable && wanted.has(i.path)) {
			counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
		}
	}
	const lines = (Object.keys(KIND_LABEL) as AuditIssue["kind"][])
		.filter((k) => counts.has(k))
		.map((k) => `• ${KIND_LABEL[k](counts.get(k) ?? 0)}`);
	return [...lines, "", "A file that fails is left exactly as it was."];
}

const KIND_COUNT: Record<IssueKind, (n: number) => string> = {
	notMp3: (n) => `${n} not MP3`,
	tagVersion: (n) => `${n} with ID3v2.4 tags`,
	misplaced: (n) => `${n} in the wrong folder`,
};

/** "3 not MP3, 1 in the wrong folder": a folder's issues in one line per kind. */
export function kindLines(kinds: FolderSummary["kinds"]): string[] {
	return (Object.keys(KIND_COUNT) as IssueKind[])
		.filter((k) => (kinds[k] ?? 0) > 0)
		.map((k) => KIND_COUNT[k](kinds[k] ?? 0));
}

/** Hover text for a file's warning icon. */
export function issueSummary(list: readonly AuditIssue[]): string {
	return list.map((i) => i.message).join("\n");
}
