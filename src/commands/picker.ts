import type { PiToolShell, ResultEnvelope } from "../types.js";
import type { PiCommandContext } from "./define.js";

export type InteractiveCommandContext = PiCommandContext & {
	ui: NonNullable<PiCommandContext["ui"]>;
};

export function hasInteractiveUi(
	ctx: PiCommandContext | undefined,
): ctx is InteractiveCommandContext {
	return Boolean(ctx?.hasUI !== false && ctx?.ui?.select && ctx.ui.notify);
}

export function notifyResult(
	ctx: InteractiveCommandContext,
	result: Pick<PiToolShell<ResultEnvelope<unknown>>, "content" | "details">,
): void {
	const text = result.content?.[0]?.text;
	if (!text) return;
	const hasError = Boolean(result.details?.error?.code);
	ctx.ui.notify(text, hasError ? "error" : "info");
}
