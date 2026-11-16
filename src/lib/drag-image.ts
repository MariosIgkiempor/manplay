import type { DragItem } from "#/lib/drag-session.ts";

const FOLDER =
	"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";
const FILE = "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4";

/**
 * The picture that follows the pointer while dragging: the first item's icon and name on a card,
 * stacked like a pile with a count badge when several are dragged. It is built from the app's
 * colour variables, so it matches the light and dark themes.
 */
export function setDragImage(dt: DataTransfer, items: readonly DragItem[]) {
	const first = items[0];
	if (first === undefined) {
		return;
	}
	const card = document.createElement("div");
	const stack = items.length > 1;
	Object.assign(card.style, {
		position: "fixed",
		top: "-1000px",
		left: "-1000px",
		display: "flex",
		alignItems: "center",
		gap: "8px",
		maxWidth: "240px",
		padding: "7px 12px 7px 9px",
		borderRadius: "10px",
		border: "1px solid var(--color-border)",
		background: "var(--color-popover)",
		color: "var(--color-popover-foreground)",
		font: "500 13px/1.2 system-ui, sans-serif",
		boxShadow: stack
			? "3px 3px 0 -1px var(--color-popover), 3px 3px 0 0 var(--color-border), 6px 6px 0 -1px var(--color-popover), 6px 6px 0 0 var(--color-border), 0 8px 24px rgb(0 0 0 / 0.35)"
			: "0 8px 24px rgb(0 0 0 / 0.35)",
		marginRight: stack ? "8px" : "0",
		marginBottom: stack ? "8px" : "0",
	});
	card.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;color:${first.isDir ? "var(--color-primary)" : "var(--color-muted-foreground)"}"><path d="${first.isDir ? FOLDER : FILE}"/></svg>`;
	const name = document.createElement("span");
	name.textContent = first.name;
	Object.assign(name.style, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
	card.append(name);
	if (stack) {
		const badge = document.createElement("span");
		badge.textContent = String(items.length);
		Object.assign(badge.style, {
			position: "absolute",
			top: "-8px",
			right: "-8px",
			minWidth: "20px",
			height: "20px",
			padding: "0 6px",
			boxSizing: "border-box",
			borderRadius: "10px",
			background: "var(--color-primary)",
			color: "var(--color-primary-foreground)",
			font: "600 11px/20px system-ui, sans-serif",
			textAlign: "center",
		});
		card.append(badge);
	}
	document.body.append(card);
	dt.setDragImage(card, 16, 16);
	// The browser copies the element when the drag starts; it is not needed after that.
	setTimeout(() => card.remove(), 0);
}
