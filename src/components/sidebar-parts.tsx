/** Right-aligned song count. */
export function RowCount({ n }: { n: number }) {
	return <span className="ml-auto pl-2 text-xs tabular-nums">{n}</span>;
}

export function SectionLabel({ children }: { children: string }) {
	return <div className="px-2 pt-1 pb-1 font-medium text-muted-foreground text-xs">{children}</div>;
}
