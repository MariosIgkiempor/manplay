import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ScopeSwitch } from "#/components/item-sharing.tsx";
import type { Scope } from "#/lib/api.ts";
import { cn } from "#/lib/utils.ts";

/** The + that starts a new playlist or tag as a row named in place. */
export function AddButton({
	label,
	onClick,
	className,
}: {
	label: string;
	onClick: () => void;
	className?: string;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onClick();
			}}
			className={cn(
				"grid size-5 shrink-0 place-items-center rounded text-muted-foreground outline-none transition-colors hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5",
				className,
			)}
		>
			<Plus />
		</button>
	);
}

/**
 * A new row waiting for its name, focused so you can type. Enter creates it; Escape, clicking
 * elsewhere or an empty name drops it. A failed create keeps the name and says why.
 */
export function NewRow({
	icon,
	indent = 8,
	placeholder,
	parse,
	onCreate,
	onCancel,
	scope,
}: {
	icon: ReactNode;
	/** Left padding in px, to sit at the level it is created at. */
	indent?: number;
	placeholder: string;
	/** Cleans the typed name; null when it cannot be used. */
	parse: (raw: string) => string | null;
	onCreate: (name: string) => Promise<unknown>;
	onCancel: () => void;
	/** Shared or private for the new item, chosen in the row (only while in a shared library). */
	scope?: { value: Scope; onChange: (next: Scope) => void } | undefined;
}) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async () => {
		const parsed = parse(name);
		if (parsed === null) {
			if (name.trim() === "") {
				onCancel();
			} else {
				setError("Names can't contain /");
			}
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await onCreate(parsed);
			onCancel();
		} catch (e) {
			setError(String(e));
			setBusy(false);
		}
	};
	return (
		<div>
			<div
				className="flex items-center gap-2 rounded-md bg-muted py-1 pr-1 text-sm"
				style={{ paddingLeft: indent }}
			>
				<span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
				<input
					// biome-ignore lint/a11y/noAutofocus: the row exists only to be named
					autoFocus
					value={name}
					disabled={busy}
					placeholder={placeholder}
					aria-label={placeholder}
					aria-invalid={error !== null || undefined}
					onChange={(e) => {
						setName(e.target.value);
						setError(null);
					}}
					onKeyDown={(e) => {
						e.stopPropagation();
						if (e.key === "Enter") {
							e.preventDefault();
							void submit();
						} else if (e.key === "Escape") {
							e.preventDefault();
							onCancel();
						}
					}}
					onBlur={(e) => {
						// Moving to the row's own scope switch keeps it open.
						if (!busy && !e.currentTarget.parentElement?.contains(e.relatedTarget)) {
							onCancel();
						}
					}}
					className="h-6 min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
				/>
				{scope && <ScopeSwitch compact value={scope.value} onChange={scope.onChange} />}
			</div>
			{error && <p className="px-2 pt-0.5 text-destructive text-xs">{error}</p>}
		</div>
	);
}
