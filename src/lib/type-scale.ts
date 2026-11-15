/**
 * The type scale every screen shares. Page titles name a screen, panel titles name what a
 * slide-over shows, section titles split a screen into parts, and labels name a single value.
 */
export const typeScale = {
	pageTitle: "font-semibold text-2xl tracking-tight",
	panelTitle: "font-semibold text-xl tracking-tight",
	sectionTitle: "font-semibold text-sm",
	label: "font-medium text-muted-foreground text-xs",
	description: "text-muted-foreground text-sm text-pretty",
} as const;
