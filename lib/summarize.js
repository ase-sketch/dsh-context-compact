/**
 * One-shot summarization and durable checkpoint framing.
 *
 * The summarization directive is delivered as the FINAL user message after the replayed
 * conversation rather than as a distinct summarizer system prompt: keeping the conversation's own
 * system prompt, tool schemas, and message prefix in front of it makes the auxiliary call a genuine
 * PREFIX of the last routed request, so the provider's KV cache is reused instead of invalidated
 * (design.md §7.2 risk 3 "prefix cache"; compaction-basic's summarizer has the same认知).
 *
 * The call is a direct `ctx.llm.stream()` one-shot. Its `compaction/summary` event records
 * `llmStreamCall: true` plus the complete `rawOutput`, which is exactly what `llm-replay` reads to
 * reconstruct this call at its log position (dsh-llm-replay/lib/index.js:229-277) — that is the
 * replay-compatibility contract of this plugin (phase4-plan.md §0 C6).
 *
 * @module @sol-pi-port/dsh-context-compact/summarize
 */
import { BlockAssembler, LlmError, contentHasImage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { systemHead } from "./selectors.js";

/** Plugin identity carried by the summarization instruction message. */
export const SUMMARIZER_PLUGIN = "dsh-context-compact";
/** Tags wrapping the structured summary inside the landed checkpoint node. */
export const SUMMARY_OPEN_TAG = "<compacted-summary>";
export const SUMMARY_CLOSE_TAG = "</compacted-summary>";

/**
 * The summarization directive. Kept close to `compaction-basic`'s contract (same section set and the
 * same "do not mention the compaction" rule) because the landed checkpoint is read by the same
 * models; the wording is this plugin's own.
 */
export const COMPACTION_INSTRUCTION = [
	"You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
	"",
	"Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
	"",
	"## Primary Request and Intent",
	"- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
	"",
	"## Key Technical Concepts",
	"- [technologies, frameworks, patterns, and conventions in play]",
	"",
	"## Files and Code",
	"- [exact path: why it matters, key changes or snippets]",
	"",
	"## Errors and Fixes",
	"- [error: how it was resolved, plus any related user feedback]",
	"",
	"## Pending Jobs",
	"- [explicitly requested work not yet completed]",
	"",
	"## Current Work",
	"- [precisely what was in progress at this checkpoint]",
	"",
	"## Next Step",
	"- [the single next action, directly in line with the most recent request, or \"(none)\"]",
	"",
	"## Critical Context",
	"- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
	"",
	"Rules:",
	"- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
	"- Capture user feedback and explicit instructions faithfully, especially corrections.",
	"- Do NOT mention this summarization request or that the context was compacted.",
	"- Output only the checkpoint text: do not call any tool or take any other action.",
	`- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join("\n");

/** Framing that makes the replacement user message established context. */
export const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

/**
 * Resolve the provider/model this summarization call should use: the explicit configured pair, else
 * the latest durably routed request, else the agent's own options.
 * @param {{ options: { provider?: string, model?: string }, session: object }} agent
 * @param {{ summarizationProvider: string, summarizationModel: string }} config
 * @returns {{ provider: string, model: string } | undefined}
 */
export function resolveSummarizationTarget(agent, config) {
	const latest = agent.session?.requestHeader?.()?.config;
	const configured = config.summarizationProvider.length === 0
		? undefined
		: { provider: config.summarizationProvider, model: config.summarizationModel };
	const agentTarget = agent.options?.provider !== undefined && agent.options.provider.length > 0 &&
			agent.options.model !== undefined && agent.options.model.length > 0
		? { provider: agent.options.provider, model: agent.options.model }
		: undefined;
	return configured ?? latest ?? agentTarget;
}

/**
 * Run the cache-reusing summarization call: replay the conversation prefix, then append the
 * compaction instruction as the final user message.
 *
 * @param {object} ctx context providing the LLM service
 * @param {{ maxTokens: number, summarizationProvider: string, summarizationModel: string }} config
 * @param {{ messages: readonly object[], tools?: readonly object[] }} input replayed prefix
 * @param {{ options: object, session: object }} agent
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ summary: object[], rawOutput: object[], llmStreamCall: true, provider: string, model: string, maxTokens: number, usage?: object }>}
 */
export async function summarizeWithLlm(ctx, config, input, agent, signal) {
	const target = resolveSummarizationTarget(agent, config);
	if (target === undefined) {
		throw new Error("no provider/model available for summarization: configure efficiency-context-compact summarizationProvider/summarizationModel, route one request, or set both AgentOptions fields");
	}
	const assembler = new BlockAssembler();
	const messages = [
		...input.messages,
		createUserMessage({
			content: [{ type: "text", text: COMPACTION_INSTRUCTION }],
			source: { kind: "plugin", plugin: SUMMARIZER_PLUGIN },
		}),
	];
	const options = {
		provider: target.provider,
		model: target.model,
		messages,
		...(input.tools === undefined ? {} : { tools: [...input.tools] }),
		maxTokens: config.maxTokens,
		sessionId: agent.session.id,
		purpose: "compaction",
		...(signal === undefined ? {} : { signal }),
	};
	for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
	const error = finishError(assembler.finish);
	if (error !== undefined) throw error;
	const rawOutput = assembler.blocks();
	const summary = summaryText(rawOutput);
	if (!summary.some((block) => block.text.trim().length > 0)) throw new Error("summarization produced no text summary content");
	return {
		summary,
		rawOutput,
		llmStreamCall: true,
		provider: options.provider,
		model: options.model,
		maxTokens: config.maxTokens,
		...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
	};
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param {readonly object[]} summary safe text-only model output
 * @returns {object[]} content for the synthesized replacement user message
 */
export function frameSummary(summary) {
	return [
		{ type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
		...summary,
		{ type: "text", text: SUMMARY_CLOSE_TAG },
	];
}

/**
 * Reconstruct the last routed request's cacheable prefix for the shadowed region: the system prompt
 * held by the `system/message` at surface node 0, the header's tool schemas, then the region's own
 * derived messages in surface order.
 * @param {object} session
 * @param {readonly number[]} shadowedSeqs surface-node seqs being compacted, in order
 * @returns {{ messages: object[], tools?: readonly object[] }}
 */
export function buildSummarizationInput(session, shadowedSeqs) {
	const header = session.requestHeader();
	const nodes = session.surface.nodes;
	const head = nodes.length === 0 ? undefined : systemHead(session, nodes[0]);
	const system = head === undefined ? null : session.deriveEventMessage(head);
	const regionMessages = shadowedSeqs
		.map((seq) => session.deriveEventMessage(session.eventAt(seq)))
		.filter((message) => message !== null);
	return {
		...(header?.tools === undefined ? {} : { tools: header.tools }),
		messages: system === null ? regionMessages : [system, ...regionMessages],
	};
}

/**
 * Map a terminal summarization finish to its fail-closed error.
 * @param {{ kind: string, failure?: { message: string, code?: string } }} finish
 * @returns {Error | undefined}
 */
export function finishError(finish) {
	switch (finish.kind) {
		case "error":
		case "aborted": {
			const error = new Error(finish.failure?.message ?? "summarization failed");
			if (finish.failure?.code !== undefined) error.code = finish.failure.code;
			return error;
		}
		case "max-tokens": {
			const error = new Error("summarization truncated at the token cap (incomplete checkpoint)");
			error.code = "MAX_TOKENS";
			return error;
		}
		default: return undefined;
	}
}

/**
 * Reject visual output and keep only text before synthesizing a user message.
 * @param {readonly object[]} blocks
 * @returns {object[]}
 */
export function summaryText(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("compaction summary cannot contain image output", "UNSUPPORTED_CONTENT");
	return blocks.filter((block) => block.type === "text");
}
