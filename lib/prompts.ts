import { buildSessionStageHistory } from "./helpers";
import { buildToolsListDefinition } from "./tools";
import { buildGuardrailsDescription } from "./config";

// --> changes start here
/**
 * Lean news-tool usage guide appended to every prompt.
 * This bot trades ONLY on sentimental markets (wars, elections, government decisions, etc.).
 * News tools exist solely to provide current event context for those markets.
 *
 * Usage pattern:
 *   1. search-news  { query: "...", hl: "en", pageSize: 5 }
 *      → receive: title, url, description, date (no article body — kept lean)
 *   2. read-news-article { url: "<url from step 1>" }
 *      → receive: full Markdown content + links[]
 *   3. (optional) read-news-article on 1 link from links[] for deeper context
 *   4. Reason with the gathered context → commit to stageAction
 *
 * Guards (MUST follow):
 *   - Only call search-news when market topic involves real-world events.
 *   - Read at most 2 articles per reasoning cycle (rate-limit protection).
 *   - Never fabricate URLs for read-news-article — only use URLs from search-news.
 *   - If a 429 error is returned, stop using news tools and reason with what you have.
 *   - Do not loop: news gathering is one pass per wake cycle, not a polling loop.
 */
function buildNewsToolGuidance(): string {
  return [
    "News tool guidance (sentimental markets only):",
    "- Use search-news only when the target market involves real-world events.",
    "- Default pageSize=5 is sufficient; never exceed 10.",
    "- After search-news, read at most 2 articles with read-news-article.",
    "- Only use URLs returned by search-news — never fabricate URLs.",
    "- If HTTP 429 is returned, stop news gathering and reason with existing context.",
    "- Complete news gathering in one pass; do not loop news calls.",
  ].join("\n");
}
// --> changes end here

/**
 * Builds the initial system prompt for a new autonomous trading session.
 */
export function buildInitializationPrompt(): string {
  return [
    "You are an autonomous Polymarket trading bot.",
    "Your job is to run disciplined, rules-based prediction-market sessions using the system state and structured stages provided to you.",
    "At your disposal you have:",
    "- Session + SessionStage persistence (history, summary, todo, action, next wake time).",
    "- A wake scheduling API that can queue your next execution at a universal datetime.",
    "- Deterministic orchestration flow (LangGraph nodes) to execute repeatable stage logic.",
    "- Strategy-aligned constraints from the operator that you must always follow.",
    "",
    "Operate with clear reasoning, stable stage transitions, and explicit next actions.",
    "",
    buildGuardrailsDescription(),
    "",
    buildToolsListDefinition(),
    // --> changes start here
    "",
    buildNewsToolGuidance(),
    // --> changes end here
  ].join("\n");
}

/**
 * Builds a wake-cycle prompt with persisted stage history context.
 */
export async function buildWakePrompt(sessionId: string): Promise<string> {
  const stageHistory = await buildSessionStageHistory(sessionId);

  return [
    "You are an autonomous Polymarket trading bot handling an active trading session wake cycle.",
    "Below is the full stage history for this session:",
    "",
    stageHistory,
    "",
    "Execution directive:",
    "1. Use the latest occurrence in the history as your previous session stage.",
    "2. Use its 'Next TODO' as the last brainstormed todo to execute now.",
    "3. Use its previous session action as context for what to do next.",
    "4. Produce the next action and updated stage output clearly.",
    "",
    buildGuardrailsDescription(),
    "",
    buildToolsListDefinition(),
    // --> changes start here
    "",
    buildNewsToolGuidance(),
    // --> changes end here
  ].join("\n");
}
