import { useRouterState } from "@tanstack/react-router";
import { Pin } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { DetailBody } from "#/components/detail-content.tsx";
import { PanelBar } from "#/components/panel-header.tsx";
import { Button } from "#/components/ui/button.tsx";
import { GrowCard } from "#/components/ui/grow-card.tsx";
import { type DetailOrigin, type DetailView, useDetail } from "#/context/detail-context.ts";
import { useStatusScopeHandlers } from "#/context/status-context.ts";
import { detailCardWidth, detailLabel } from "#/lib/detail-views.ts";

/** A card on show: the view in it, and what it grew out of. */
interface Card {
	view: DetailView;
	origin: DetailOrigin;
	opened: number;
}

/**
 * Details as a card grown out of whatever opened them: a song from its row, an album from its
 * tile, a review from its button. The card has the side panel's top bar (Back, the view's own
 * buttons, Close) and a pin, which moves it into the side panel to stay beside the page.
 */
export function DetailCard(): ReactNode {
	const detail = useDetail();
	const { close } = detail;
	const scopeHandlers = useStatusScopeHandlers("panel");
	const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
	const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
	const slots = useMemo(
		() => ({ title: titleSlot, actions: actionsSlot }),
		[titleSlot, actionsSlot],
	);

	const open = detail.view !== null && !detail.pinned;
	// While it shrinks back the card keeps showing what it held.
	const [card, setCard] = useState<Card | null>(null);
	if (open && detail.view && (card?.view !== detail.view || card.opened !== detail.opened)) {
		setCard({ view: detail.view, origin: detail.origin, opened: detail.opened });
	}
	// Pinned, the view is in the side panel at once: there is nothing to shrink back.
	if (detail.pinned && card !== null) {
		setCard(null);
	}

	// A card belongs to the page it grew on.
	const path = useRouterState({ select: (state) => state.location.pathname });
	const openRef = useRef(open);
	openRef.current = open;
	// biome-ignore lint/correctness/useExhaustiveDependencies: closes when the page changes
	useEffect(() => {
		if (openRef.current) {
			close();
		}
	}, [path, close]);

	if (!card) {
		return null;
	}
	return (
		<GrowCard
			key={card.opened}
			open={open}
			originElement={card.origin.element}
			originBox={card.origin.box}
			onClose={close}
			onClosed={() => setCard(null)}
			label={detailLabel(card.view)}
			width={detailCardWidth(card.view)}
			className="@container/split px-5 pt-5"
			bar={
				<div {...scopeHandlers}>
					<PanelBar
						canGoBack={detail.canGoBack}
						onBack={detail.back}
						onClose={close}
						closeLabel="Close"
						onTitleSlot={setTitleSlot}
						onActionsSlot={setActionsSlot}
						extra={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Pin beside the page"
								data-hint="Keep this open beside the page, in the side panel"
								onClick={detail.pin}
							>
								<Pin />
							</Button>
						}
					/>
				</div>
			}
		>
			<div {...scopeHandlers}>
				<DetailBody view={card.view} slots={slots} />
			</div>
		</GrowCard>
	);
}
