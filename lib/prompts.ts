import { buildSessionStageHistory } from "./helpers";
import { buildToolsListDefinition } from "./tools";

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
    buildToolsListDefinition(),
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
    buildToolsListDefinition(),
  ].join("\n");
}
