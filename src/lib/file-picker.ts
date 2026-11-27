import { useSyncExternalStore } from "react";
import type { FsEntry } from "#/lib/api.ts";
import { joinPath } from "#/lib/fs-path.ts";

/**
 * The app's own file picker, asked for from anywhere: {@link pickPath} opens it and resolves to
 * the path the user chose. The dialog itself is `FilePickerHost`, mounted once in the shell.
 */

/** What a picker is for; each remembers the folder it was last used in. */
export type PickPurpose = "library" | "import" | "cover";

interface PickBase {
	purpose: PickPurpose;
	title: string;
	confirmLabel: string;
}

/** Choose an existing folder. */
export interface FolderPick extends PickBase {
	kind: "folder";
}

/** Choose an existing file with one of these extensions (lower case, no dot). */
export interface FilePick extends PickBase {
	kind: "file";
	extensions: readonly string[];
}

/** Choose a folder and a name for a file to write there. */
export interface SavePick extends PickBase {
	kind: "save";
	defaultName: string;
	/** Added to a name typed without it (lower case, no dot). */
	extension: string;
}

export type PickRequest = FolderPick | FilePick | SavePick;

interface Pending {
	request: PickRequest;
	resolve: (path: string | null) => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();

function setPending(next: Pending | null) {
	pending = next;
	for (const listener of listeners) {
		listener();
	}
}

/** Opens the picker. Resolves to the chosen path, or null when the user cancels. */
export function pickPath(request: PickRequest): Promise<string | null> {
	return new Promise((resolve) => {
		// Only one picker shows at a time; a second request takes the first one's place.
		pending?.resolve(null);
		setPending({ request, resolve });
	});
}

/** Closes the open picker with the user's answer. */
export function answerPick(path: string | null): void {
	const answered = pending;
	setPending(null);
	answered?.resolve(path);
}

/** Whether the picker is on screen, for what sits under it and must not close while it is. */
export function isPickOpen(): boolean {
	return pending !== null;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The request the picker is open for, or null while it is closed. */
export function usePendingPick(): PickRequest | null {
	return useSyncExternalStore(
		subscribe,
		() => pending?.request ?? null,
		() => null,
	);
}

const folderKey = (purpose: PickPurpose) => `file-picker-folder:${purpose}`;

/** The folder this kind of picker was last used in, on this device. */
export function rememberedFolder(purpose: PickPurpose): string | null {
	try {
		return localStorage.getItem(folderKey(purpose));
	} catch {
		return null;
	}
}

export function rememberFolder(purpose: PickPurpose, folder: string): void {
	try {
		localStorage.setItem(folderKey(purpose), folder);
	} catch {
		// Not remembered; the next picker starts from the home folder.
	}
}

/** A file name's extension, lower case, without the dot; empty when it has none. */
export function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Whether clicking this entry does something: folders open, and files only where one is picked. */
export function isUsable(entry: FsEntry, request: PickRequest): boolean {
	if (entry.isDir) {
		return true;
	}
	switch (request.kind) {
		case "folder":
			return false;
		case "file":
			return request.extensions.includes(extensionOf(entry.name));
		case "save":
			return extensionOf(entry.name) === request.extension;
	}
}

/**
 * The entries the picker lists: every folder, plus the files that say what a folder holds. A
 * picker for a file leaves out the files it cannot take; a filter keeps names containing it.
 */
export function visibleEntries(
	entries: readonly FsEntry[],
	request: PickRequest,
	filter: string,
): FsEntry[] {
	const needle = filter.trim().toLowerCase();
	return entries.filter(
		(entry) =>
			(request.kind !== "file" || isUsable(entry, request)) &&
			(needle === "" || entry.name.toLowerCase().includes(needle)),
	);
}

export type SaveName = { ok: true; name: string } | { ok: false; problem: string };

/** Characters no file name may hold on Windows or macOS. */
const FORBIDDEN = /[<>:"/\\|?*]/;

function hasControlCharacter(name: string): boolean {
	return [...name].some((character) => (character.codePointAt(0) ?? 0) < 32);
}

/** The file name to save under, from what was typed: checked, with the extension added. */
export function saveName(typed: string, extension: string): SaveName {
	const trimmed = typed.trim();
	if (trimmed === "") {
		return { ok: false, problem: "Type a name for the file" };
	}
	if (FORBIDDEN.test(trimmed) || hasControlCharacter(trimmed)) {
		return { ok: false, problem: 'A name cannot contain < > : " / \\ | ? or *' };
	}
	const suffix = `.${extension}`;
	const stem = trimmed.toLowerCase().endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
	// Windows drops trailing dots and spaces, so the file would get another name than shown.
	if (stem.replace(/[. ]+$/, "") !== stem || stem === "") {
		return { ok: false, problem: "A name cannot be only dots, or end with a dot or a space" };
	}
	return { ok: true, name: `${stem}${suffix}` };
}

/** The entry already in the folder under this name, as the file system sees names (any case). */
export function existingEntry(entries: readonly FsEntry[], name: string): FsEntry | undefined {
	const wanted = name.toLowerCase();
	return entries.find((entry) => entry.name.toLowerCase() === wanted);
}

/** What pressing the save button does with the name as typed. */
export type SaveDecision =
	| { kind: "problem"; problem: string }
	/** A file has that name; the user is asked before it is replaced. */
	| { kind: "askReplace"; name: string }
	| { kind: "save"; name: string };

/**
 * Decides a save in a folder holding `entries`. A file already there is replaced only once the
 * user has been asked (`replaceAsked`); a folder of that name never is.
 */
export function saveDecision(
	typed: string,
	extension: string,
	entries: readonly FsEntry[],
	replaceAsked: boolean,
): SaveDecision {
	const named = saveName(typed, extension);
	if (!named.ok) {
		return { kind: "problem", problem: named.problem };
	}
	const existing = existingEntry(entries, named.name);
	if (existing?.isDir) {
		return { kind: "problem", problem: `“${existing.name}” is a folder here. Use another name.` };
	}
	return { kind: existing && !replaceAsked ? "askReplace" : "save", name: named.name };
}

/** What the picker would hand back right now, or null while there is nothing to choose yet. */
export function pickTarget(
	request: PickRequest,
	folder: string,
	selectedFile: string | null,
	typedName: string,
): string | null {
	switch (request.kind) {
		case "folder":
			return folder;
		case "file":
			return selectedFile === null ? null : joinPath(folder, selectedFile);
		case "save": {
			const named = saveName(typedName, request.extension);
			return named.ok ? joinPath(folder, named.name) : null;
		}
	}
}
