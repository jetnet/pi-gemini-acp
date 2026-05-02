import { type Static, Type } from "@mariozechner/pi-ai";
import {
	describeGeminiModelChoices,
	listGeminiModelChoices,
	type ModelSelectionDeps,
	setGeminiAcpModel,
} from "../config/model.js";
import { errorResult, toolResult } from "../tools/result.js";
import { defineGeminiCommand, type PiCommandContext } from "./define.js";
import { hasOverlayUi, showPickerOverlay, toastShell } from "./picker.js";

export const geminiModelSchema = Type.Object({
	model: Type.Optional(
		Type.String({
			description:
				"Gemini model choice, alias, or full model id. Try pro, flash, flash-lite, or gemini-3.1-pro-preview.",
			examples: listGeminiModelChoices().flatMap((choice) => [
				choice.aliases[0],
				choice.id,
			]),
		}),
	),
});

type Params = Static<typeof geminiModelSchema>;

export async function setGeminiModel(
	params: Params,
	deps: ModelSelectionDeps & { rootDir?: string } = {},
) {
	const model = params.model?.trim();
	if (!model) return modelChoiceResult();
	const result = await setGeminiAcpModel(
		{ model, rootDir: deps.rootDir },
		deps,
	);
	if (result.error) return errorResult(result.error);
	return toolResult({
		text: `${result.status.message} Gemini ACP tools will pass this model when the configured command supports --model.`,
		data: result,
	});
}

export async function runGeminiModelCommand(
	params: Params,
	ctx?: PiCommandContext,
) {
	const model = params.model?.trim();
	if (!model && hasOverlayUi(ctx)) return showGeminiModelPicker(ctx);
	return setGeminiModel(params);
}

export function getGeminiModelCompletions(prefix: string) {
	const normalized = prefix.trim().toLowerCase();
	const completions = listGeminiModelChoices().flatMap((choice) => {
		const terms = [choice.id, choice.label, ...choice.aliases].map((term) =>
			term.toLowerCase(),
		);
		if (normalized && !terms.some((term) => term.startsWith(normalized)))
			return [];
		return [
			{
				value: choice.id,
				label: `${choice.label} — ${choice.description}`,
			},
		];
	});
	return completions.length > 0 ? completions : null;
}

function showGeminiModelPicker(ctx: ReturnType<typeof assertOverlayCtx>) {
	const choices = listGeminiModelChoices();
	showPickerOverlay(
		ctx,
		"Choose a Gemini model",
		choices.map((choice) => ({
			label: `${choice.label || choice.id} — ${choice.id}`,
			onClick: () => {
				void (async () => {
					const result = await setGeminiModel({ model: choice.id });
					toastShell(ctx, result);
				})();
			},
		})),
		[
			"Gemini ACP will use the selected model when the command supports --model.",
		],
	);
	return toolResult({
		text: "Choose a Gemini model from the picker.",
		data: { choices },
	});
}

function assertOverlayCtx(ctx: PiCommandContext) {
	return ctx as PiCommandContext & { ui: NonNullable<PiCommandContext["ui"]> };
}

function modelChoiceResult() {
	const choices = listGeminiModelChoices();
	return toolResult({
		text: [
			"Choose a Gemini model with `/gemini-model <choice>`:",
			...choices.map(
				(choice) =>
					`- ${choice.id}: ${choice.description} Aliases: ${choice.aliases.join(", ")}`,
			),
			`You can also pass a full Gemini model id. Known choices: ${describeGeminiModelChoices()}.`,
		].join("\n"),
		data: { choices },
	});
}

export const geminiModelCommand = defineGeminiCommand({
	name: "gemini-model",
	description:
		"Persist the preferred Gemini model after confirming the configured ACP command supports model selection.",
	parameters: geminiModelSchema,
	getArgumentCompletions: getGeminiModelCompletions,
	execute: (params, ctx) => runGeminiModelCommand(params, ctx),
});
