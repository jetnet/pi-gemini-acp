import type { PiToolShell } from "../types.js";
import type { PiCommandContext, PiComponentTree } from "./define.js";

export type InteractiveCommandContext = PiCommandContext & {
	ui: NonNullable<PiCommandContext["ui"]>;
};

export interface PickerButton {
	label: string;
	onClick: () => void;
}

export function hasOverlayUi(
	ctx: PiCommandContext | undefined,
): ctx is InteractiveCommandContext {
	return Boolean(
		ctx?.hasUI !== false && ctx?.ui?.showOverlay && ctx.ui.showToast,
	);
}

export function showPickerOverlay(
	ctx: InteractiveCommandContext,
	title: string,
	buttons: PickerButton[],
	textLines: string[] = [],
): void {
	ctx.ui.showOverlay({
		render: () => ({
			type: "vstack",
			children: [
				{ type: "text", text: title },
				...textLines.map((text): PiComponentTree => ({ type: "text", text })),
				...buttons.map(
					(button): PiComponentTree => ({
						type: "button",
						label: button.label,
						onClick: button.onClick,
					}),
				),
			],
		}),
		zIndex: 100,
		onClickOutside: () => {},
	});
}

export function toastShell(
	ctx: InteractiveCommandContext,
	result: Pick<PiToolShell, "content" | "details">,
): void {
	const text = result.content?.[0]?.text;
	if (!text) return;
	const hasError = Boolean(
		(result.details as { error?: { code?: string } } | undefined)?.error?.code,
	);
	ctx.ui.showToast(hasError ? `Error: ${text}` : text);
}

export function closePickerToast(ctx: InteractiveCommandContext): void {
	// Pi's documented overlay primitive does not expose an imperative close handle;
	// click-outside dismissal is handled by the host, while Done gives feedback.
	ctx.ui.showToast("Picker closed.");
}
