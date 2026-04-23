import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { END, START, Annotation, StateGraph } from "@langchain/langgraph";
import { Side } from "@polymarket/clob-client-v2";
import { randomUUID } from "node:crypto";
import {
  createNewStage,
  createNewTask,
  markLatestStageActionCompleted,
  SessionAction,
} from "../actions/db";
import { aiModelResponseSchema } from "../lib/aiSchemas";
import { botConfig } from "../lib/config";
import {
  acquireStageLock,
  clearSessionOrderId,
  getSessionOrderId,
  releaseStageLock,
  setSessionOrderId,
} from "../lib/helpers";
import { startHeartbeat, stopHeartbeat } from "../lib/heartbeat";
import { buildInitializationPrompt, buildWakePrompt } from "../lib/prompts";
import { executeTool } from "../lib/tools";
import type {
  AiGraphMessage,
  CompileTradingGraphParams,
  TradingGraphNodeState,
} from "../types/ai";
import type { AiModelResponse, ToolCall } from "../types/aiSchemas";
import type { OpenOrderRecord, ToolExecutorConfig, ToolResponse } from "../types/tools";
import { getOpenOrders, initPolymarketClient } from "../polymarket-endpoint";

const UNIVERSAL_MODEL_NAME = "gemini-2.5-flash";

const tradingGraphState = Annotation.Root({
  sessionId: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  wakeTraceId: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  forceInitPath: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
  prompt: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  messages: Annotation<AiGraphMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  aiResponse: Annotation<AiModelResponse | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  intendedStartTradeOrder: Annotation<TradingGraphNodeState["intendedStartTradeOrder"]>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  toolResults: Annotation<ToolResponse<unknown>[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  stageActionComplete: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => true,
  }),
  stopReason: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

/**
 * Returns an ISO string fallback wake time when a stage action does not provide one.
 */
function getDefaultWakeTime(): string {
  return new Date(Date.now() + 5 * 60 * 1000).toISOString();
}

/**
 * Converts graph stage actions into persisted SessionAction enum values.
 */
function toPersistedSessionAction(stageAction: AiModelResponse["nextStage"]["stageAction"]): SessionAction {
  switch (stageAction) {
    case "START_TRADE":
      return SessionAction.START_TRADE;
    case "END_TRADE":
      return SessionAction.END_TRADE;
    case "SKIP":
      return SessionAction.SKIP;
    case "WAIT":
    case "CLARIFY":
    case null:
      return SessionAction.WAIT;
    default: {
      const unsupported = stageAction satisfies never;
      throw new Error(`Unsupported stage action: ${unsupported}`);
    }
  }
}

/**
 * Extracts the wake timestamp from stage action metadata when one exists.
 */
function getResumeAt(aiResponse: AiModelResponse): string | null {
  const action = aiResponse.nextStage.stageAction;
  const actionData = aiResponse.nextStage.stageActionData;

  if (!action || !actionData || typeof actionData !== "object") {
    return null;
  }

  if (action === "START_TRADE" || action === "WAIT" || action === "CLARIFY") {
    if ("resumeAt" in actionData && typeof actionData.resumeAt === "string") {
      return actionData.resumeAt;
    }
  }

  return null;
}

/**
 * Determines whether createNewStage should schedule wake for this action.
 */
function shouldScheduleWake(aiResponse: AiModelResponse): boolean {
  const action = aiResponse.nextStage.stageAction;
  return action === "START_TRADE" || action === "WAIT" || action === "CLARIFY";
}

/**
 * Ensures there is a working session for stage persistence and token storage.
 */
async function ensureSessionId(sessionId: string | null): Promise<string> {
  if (sessionId) {
    return sessionId;
  }

  const createdSession = await createNewTask({
    name: `Autonomous session ${new Date().toISOString()}`,
    metadata: { targetToken: null },
  });

  return createdSession.id;
}

/**
 * Persists one structured AI output as a new stage linked to the active session.
 */
async function persistAiStage(sessionId: string, aiResponse: AiModelResponse): Promise<void> {
  const nextWake = getResumeAt(aiResponse) ?? getDefaultWakeTime();
  await createNewStage(sessionId, {
    summary: aiResponse.nextStage.summary,
    todo: aiResponse.nextStage.todo,
    sessionAction: toPersistedSessionAction(aiResponse.nextStage.stageAction),
    stageActionCompleted: false,
    nextWake,
    scheduleWake: shouldScheduleWake(aiResponse),
  });
}

/**
 * Formats chat history for the model as role-prefixed transcript lines.
 */
function formatConversation(messages: AiGraphMessage[]): string {
  return messages.map((message) => `[${message.role.toUpperCase()}] ${message.content}`).join("\n\n");
}

/**
 * Creates strict model instructions for tool reasoning and stop-condition behavior.
 */
function buildModelInstruction(): string {
  const g = botConfig.tradeGuardrails;
  const guardrailLine = [
    `Guardrails: maxOrderSize=$${g.maxOrderSizeUsdc}USDC,`,
    `maxExposure=$${g.maxExposureUsdc}USDC,`,
    `price=${g.minPrice}-${g.maxPrice},`,
    `sides=${g.allowedSides.join("/")},`,
    `dryRun=${g.dryRun}.`,
  ].join(" ");

  return [
    "You are the autonomous trading reasoner.",
    "Return only JSON that matches the provided schema.",
    "Use toolCalls only for decision-support data gathering.",
    "When you are fully confident, set nextStage.stageAction and stageActionData.",
    "Stop condition: reasoning loop ends only when nextStage.stageAction is non-null.",
    "If more information is needed, keep nextStage.stageAction as null and use toolCalls.",
    "If START_TRADE reports an existing open order, validate it against intended shape before cancelling or retrying.",
    "If you need to send a message to the owner of the bot in order to get useful information or call their attention to an issue you are facing, then use the nextStage.stageAction clarify option and include the message breakdown in html.",
    "When using save-target-token or update-target-token, include token metadata that should be persisted.",
    guardrailLine,
  ].join(" ");
}

/**
 * Calls the universal model and validates its JSON response against the structured schema.
 */
async function invokeUniversalModel(messages: AiGraphMessage[]): Promise<AiModelResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required for AI graph execution.");
  }

  const model = new ChatGoogleGenerativeAI({
    apiKey,
    model: UNIVERSAL_MODEL_NAME,
    temperature: 0,
  });

  const structuredModel = model.withStructuredOutput(aiModelResponseSchema, {
    name: "AiModelResponse",
  });

  return structuredModel.invoke([
    new SystemMessage(buildModelInstruction()),
    new HumanMessage(formatConversation(messages)),
  ]);
}

/**
 * Adds a server message to the graph conversation state.
 */
function createServerMessage(content: string): AiGraphMessage {
  return {
    role: "server",
    content,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Adds an AI message to the graph conversation state.
 */
function createAiMessage(content: string): AiGraphMessage {
  return {
    role: "ai",
    content,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Initial node for wake executions when a sessionId is provided.
 */
async function loadWakePromptNode(state: TradingGraphNodeState) {
  if (!state.sessionId) {
    throw new Error("load-wake-prompt requires sessionId.");
  }

  const prompt = await buildWakePrompt(state.sessionId);
  return {
    prompt,
    messages: [createServerMessage(prompt)],
  };
}

/**
 * Initial node for first-run executions without an existing session.
 */
function loadInitializationPromptNode() {
  const prompt = buildInitializationPrompt();
  return {
    prompt,
    messages: [createServerMessage(prompt)],
  };
}

/**
 * Runs one reasoning turn with the model and persists the structured output as a stage.
 */
async function runModelNode(state: TradingGraphNodeState) {
  const aiResponse = await invokeUniversalModel(state.messages);
  const sessionId = await ensureSessionId(state.sessionId);
  await persistAiStage(sessionId, aiResponse);

  if (aiResponse.toolCalls.length === 0 && aiResponse.nextStage.stageAction === null) {
    throw new Error(
      "Invalid model output: either request at least one toolCall or set nextStage.stageAction.",
    );
  }

  return {
    sessionId,
    aiResponse,
    messages: [createAiMessage(JSON.stringify(aiResponse))],
  };
}

/**
 * Executes requested decision-support tools and appends results as server messages.
 */
async function runToolCallsNode(state: TradingGraphNodeState) {
  if (!state.aiResponse) {
    throw new Error("Cannot run tool calls without an AI response.");
  }

  const toolCalls = state.aiResponse.toolCalls;
  if (toolCalls.length === 0) {
    return {};
  }

  const results: ToolResponse<unknown>[] = [];
  const serverMessages: AiGraphMessage[] = [];

  for (const toolCall of toolCalls) {
    const result = await executeTool(
      toolCall.tool,
      withSessionIdForTokenTools(toolCall, state.sessionId),
    );
    results.push(result as ToolResponse<unknown>);
    serverMessages.push(
      createServerMessage(
        JSON.stringify({
          kind: "tool-result",
          tool: toolCall.tool,
          result,
        }),
      ),
    );
  }

  return {
    toolResults: results,
    messages: serverMessages,
  };
}

/**
 * Ensures token mutation tools always execute with a resolved sessionId.
 */
function withSessionIdForTokenTools(
  toolCall: ToolCall,
  sessionId: string | null,
): ToolExecutorConfig {
  if (toolCall.tool !== "save-target-token" && toolCall.tool !== "update-target-token") {
    return toolCall.metadata as ToolExecutorConfig;
  }

  const resolvedSessionId = toolCall.metadata.sessionId ?? sessionId;
  if (!resolvedSessionId) {
    throw new Error(`${toolCall.tool} requires a sessionId.`);
  }

  return {
    ...toolCall.metadata,
    sessionId: resolvedSessionId,
  };
}

type StageActionData = NonNullable<AiModelResponse["nextStage"]["stageActionData"]>;

type StartTradeActionData = {
  reason: string;
  resumeAt: string;
  order: {
    tokenId: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
  };
};

type EndTradeActionData = {
  reason: string;
};

type WaitActionData = {
  reason: string;
  resumeAt: string;
};

type SkipActionData = {
  reason: string;
};

type ClarifyActionData = {
  reason: string;
  userMessageHtml: string;
  resumeAt: string;
};

type StartTradeOrder = StartTradeActionData["order"];

function asStartTradeActionData(data: StageActionData | null): StartTradeActionData {
  if (
    data === null ||
    typeof data !== "object" ||
    !("order" in data) ||
    !("resumeAt" in data) ||
    !("reason" in data)
  ) {
    throw new Error("START_TRADE requires valid stageActionData.");
  }

  return data as StartTradeActionData;
}

function asEndTradeActionData(data: StageActionData | null): EndTradeActionData {
  if (data === null || typeof data !== "object" || !("reason" in data)) {
    throw new Error("END_TRADE requires valid stageActionData.");
  }

  return data as EndTradeActionData;
}

function asWaitActionData(data: StageActionData | null): WaitActionData {
  if (
    data === null ||
    typeof data !== "object" ||
    !("reason" in data) ||
    !("resumeAt" in data)
  ) {
    throw new Error("WAIT requires valid stageActionData.");
  }

  return data as WaitActionData;
}

function asSkipActionData(data: StageActionData | null): SkipActionData {
  if (data === null || typeof data !== "object" || !("reason" in data)) {
    throw new Error("SKIP requires valid stageActionData.");
  }

  return data as SkipActionData;
}

function asClarifyActionData(data: StageActionData | null): ClarifyActionData {
  if (
    data === null ||
    typeof data !== "object" ||
    !("reason" in data) ||
    !("userMessageHtml" in data) ||
    !("resumeAt" in data)
  ) {
    throw new Error("CLARIFY requires valid stageActionData.");
  }

  return data as ClarifyActionData;
}

function getRequiredSessionId(sessionId: string | null): string {
  if (!sessionId) {
    throw new Error("Stage action execution requires a sessionId.");
  }

  return sessionId;
}

function extractOrderId(orderResult: unknown): string {
  if (!orderResult || typeof orderResult !== "object") {
    throw new Error("Order execution did not return a valid payload.");
  }

  const result = orderResult as Record<string, unknown>;
  const candidate = result.orderID ?? result.orderId ?? result.id;

  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("Unable to extract order id from order execution response.");
  }

  return candidate;
}

function validateStartTradeOrder(order: StartTradeOrder): StartTradeOrder {
  if (!order.tokenId.trim()) {
    throw new Error("START_TRADE order.tokenId must be non-empty.");
  }
  if (order.side !== "BUY" && order.side !== "SELL") {
    throw new Error("START_TRADE order.side must be BUY or SELL.");
  }
  if (!Number.isFinite(order.price) || order.price <= 0) {
    throw new Error("START_TRADE order.price must be a positive finite number.");
  }
  if (!Number.isFinite(order.size) || order.size <= 0) {
    throw new Error("START_TRADE order.size must be a positive finite number.");
  }

  const g = botConfig.tradeGuardrails;

  if (!g.allowedSides.includes(order.side)) {
    throw new Error(`START_TRADE order.side "${order.side}" is not in allowedSides: ${g.allowedSides.join(", ")}.`);
  }
  if (order.size > g.maxOrderSizeUsdc) {
    throw new Error(`START_TRADE order.size ${order.size} exceeds maxOrderSizeUsdc ${g.maxOrderSizeUsdc}.`);
  }
  if (order.price < g.minPrice || order.price > g.maxPrice) {
    throw new Error(`START_TRADE order.price ${order.price} is outside allowed range [${g.minPrice}, ${g.maxPrice}].`);
  }

  return order;
}

function orderLooksEquivalent(
  intended: StartTradeOrder,
  openOrder: OpenOrderRecord,
): boolean {
  if (openOrder.asset_id !== intended.tokenId) {
    return false;
  }

  if (typeof openOrder.side === "string" && openOrder.side !== intended.side) {
    return false;
  }

  if (typeof openOrder.price === "string") {
    const parsedPrice = Number(openOrder.price);
    if (Number.isFinite(parsedPrice) && Math.abs(parsedPrice - intended.price) > 1e-9) {
      return false;
    }
  }

  return true;
}

/**
 * Executes terminal stage-action side effects and closes the loop.
 */
async function runStageActionNode(state: TradingGraphNodeState) {
  if (!state.aiResponse) {
    throw new Error("Cannot execute stage action without an AI response.");
  }

  const stageAction = state.aiResponse.nextStage.stageAction;
  const stageActionData = state.aiResponse.nextStage.stageActionData;

  if (!stageAction) {
    return { stopReason: "No stage action selected yet." };
  }

  const sessionId = getRequiredSessionId(state.sessionId);
  const wakeTraceId = state.wakeTraceId ?? randomUUID();
  await acquireStageLock(sessionId, wakeTraceId);

  try {
    switch (stageAction) {
      case "START_TRADE": {
        const actionData = asStartTradeActionData(stageActionData);
        const intendedOrder = validateStartTradeOrder(
          state.intendedStartTradeOrder ?? actionData.order,
        );

        const openOrders = await getOpenOrders({ tokenId: intendedOrder.tokenId });
        const [existingOrder] = openOrders;
        if (existingOrder) {
          const likelyMatch = orderLooksEquivalent(intendedOrder, existingOrder);
          await setSessionOrderId(sessionId, existingOrder.id);

        return {
          stageActionComplete: false,
          intendedStartTradeOrder: intendedOrder,
          stopReason: null,
            messages: [
              createServerMessage(
                `Existing open order ${existingOrder.id} found for token ${intendedOrder.tokenId}. likelyMatch=${likelyMatch}. Details: ${JSON.stringify(existingOrder)}. Validate against intended shape; call cancel-unwanted-order if mismatched.`,
              ),
            ],
          };
        }

        if (botConfig.tradeGuardrails.dryRun) {
          await markLatestStageActionCompleted(sessionId, true);
          startHeartbeat(sessionId);
          return {
            stageActionComplete: true,
            intendedStartTradeOrder: intendedOrder,
            stopReason: "Stage action completed: START_TRADE (dry-run)",
            messages: [
              createServerMessage(
                JSON.stringify({
                  kind: "stage-action-result",
                  stageAction,
                  status: "dry-run",
                  reason: actionData.reason,
                  resumeAt: actionData.resumeAt,
                  order: intendedOrder,
                  orderId: null,
                }),
              ),
            ],
          };
        }

        const client = await initPolymarketClient();
        const side = intendedOrder.side === "BUY" ? Side.BUY : Side.SELL;
        const orderResult = await client.createAndPostOrder({
          tokenID: intendedOrder.tokenId,
          side,
          price: intendedOrder.price,
          size: intendedOrder.size,
        });
        const orderId = extractOrderId(orderResult);

        try {
          await setSessionOrderId(sessionId, orderId);
        } catch (metadataError) {
          try {
            await client.cancelOrder({ orderID: orderId });
          } catch (rollbackError) {
            throw new Error(
              `Placed order ${orderId} but failed to persist metadata and rollback cancel failed: ${String(rollbackError)}`,
            );
          }

          throw new Error(
            `Placed order ${orderId} but failed to persist metadata. Rolled order back. ${String(metadataError)}`,
          );
        }

        await markLatestStageActionCompleted(sessionId, true);
        startHeartbeat(sessionId);
        return {
          stageActionComplete: true,
          intendedStartTradeOrder: intendedOrder,
          stopReason: "Stage action completed: START_TRADE",
          messages: [
            createServerMessage(
              JSON.stringify({
                kind: "stage-action-result",
                stageAction,
                status: "executed",
                reason: actionData.reason,
                resumeAt: actionData.resumeAt,
                order: intendedOrder,
                orderId,
                result: orderResult,
              }),
            ),
          ],
        };
      }
      case "END_TRADE": {
        const actionData = asEndTradeActionData(stageActionData);
        const client = await initPolymarketClient();

        let closePath: "specific-order" | "fallback-cancel-all" = "specific-order";
        let result: unknown;
        let orderId: string | null = null;

        try {
          orderId = await getSessionOrderId(sessionId);
          result = await client.cancelOrder({ orderID: orderId });
        } catch {
          closePath = "fallback-cancel-all";
          result = await client.cancelAll();
        }

        await clearSessionOrderId(sessionId);
        await markLatestStageActionCompleted(sessionId, true);
        stopHeartbeat(sessionId);

        return {
          stageActionComplete: true,
          intendedStartTradeOrder: null,
          stopReason: "Stage action completed: END_TRADE",
          messages: [
            createServerMessage(
              JSON.stringify({
                kind: "stage-action-result",
                stageAction,
                status: "executed",
                reason: actionData.reason,
                closePath,
                orderId,
                result,
              }),
            ),
          ],
        };
      }
      case "WAIT": {
        const actionData = asWaitActionData(stageActionData);
        await markLatestStageActionCompleted(sessionId, true);

        return {
          stageActionComplete: true,
          stopReason: "Stage action completed: WAIT",
          messages: [
            createServerMessage(
              JSON.stringify({
                kind: "stage-action-result",
                stageAction,
                status: "scheduled",
                reason: actionData.reason,
                resumeAt: actionData.resumeAt,
              }),
            ),
          ],
        };
      }
      case "SKIP": {
        const actionData = asSkipActionData(stageActionData);
        await markLatestStageActionCompleted(sessionId, true);

        return {
          stageActionComplete: true,
          stopReason: "Stage action completed: SKIP",
          messages: [
            createServerMessage(
              JSON.stringify({
                kind: "stage-action-result",
                stageAction,
                status: "skipped",
                reason: actionData.reason,
              }),
            ),
          ],
        };
      }
      case "CLARIFY": {
        const actionData = asClarifyActionData(stageActionData);
        await markLatestStageActionCompleted(sessionId, true);

        return {
          stageActionComplete: true,
          stopReason: "Stage action completed: CLARIFY",
          messages: [
            createServerMessage(
              JSON.stringify({
                kind: "stage-action-result",
                stageAction,
                status: "clarify",
                reason: actionData.reason,
                userMessageHtml: actionData.userMessageHtml,
                resumeAt: actionData.resumeAt,
              }),
            ),
          ],
        };
      }
      default: {
        const unsupported = stageAction satisfies never;
        throw new Error(`Unsupported stage action: ${unsupported}`);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : "UnknownError";
    let stageUpdateError: string | null = null;

    try {
      await markLatestStageActionCompleted(sessionId, false);
    } catch (markError) {
      stageUpdateError = markError instanceof Error ? markError.message : String(markError);
    }

    return {
      stageActionComplete: false,
      stopReason: null,
      messages: [
        createServerMessage(
          JSON.stringify({
            kind: "stage-action-result",
            stageAction,
            status: "failed",
            fallback: "model-next-step-required",
            error: {
              name: errorName,
              message: errorMessage,
            },
            stageUpdateError,
          }),
        ),
      ],
    };
  } finally {
    await releaseStageLock(sessionId, wakeTraceId);
  }
}

/**
 * Routes the first edge based on whether the compiler received a sessionId and forceInitPath flag.
 */
function routeInitialPromptNode(state: TradingGraphNodeState) {
  if (state.sessionId && !state.forceInitPath) {
    return "load-wake-prompt";
  }
  return "load-init-prompt";
}

/**
 * Routes model output into tool execution loop or terminal stage-action execution.
 */
function routeAfterModelNode(state: TradingGraphNodeState) {
  if (!state.aiResponse) {
    throw new Error("Model routing requires an AI response.");
  }

  if (state.aiResponse.toolCalls.length > 0) {
    return "run-tool-calls";
  }

  if (state.aiResponse.nextStage.stageAction !== null) {
    return "run-stage-action";
  }

  return "run-model";
}

/**
 * Routes post-stage-action flow into loop-back or terminal end.
 */
function routeAfterStageActionNode(state: TradingGraphNodeState) {
  if (state.stageActionComplete) {
    return END;
  }

  return "run-model";
}

/**
 * Compiles the trading graph and binds the optional compiler-level sessionId seed.
 */
export function compileTradingGraph(params: CompileTradingGraphParams = {}) {
  const graphBuilder = new StateGraph(tradingGraphState)
    .addNode("load-wake-prompt", loadWakePromptNode)
    .addNode("load-init-prompt", loadInitializationPromptNode)
    .addNode("run-model", runModelNode)
    .addNode("run-tool-calls", runToolCallsNode)
    .addNode("run-stage-action", runStageActionNode)
    .addConditionalEdges(START, routeInitialPromptNode)
    .addEdge("load-wake-prompt", "run-model")
    .addEdge("load-init-prompt", "run-model")
    .addConditionalEdges("run-model", routeAfterModelNode)
    .addEdge("run-tool-calls", "run-model")
    .addConditionalEdges("run-stage-action", routeAfterStageActionNode);

  const graph = graphBuilder.compile({
    name: "polymarket-trading-graph",
  });

  return {
    graph,
    invoke: () =>
      graph.invoke({
        sessionId: params.sessionId ?? null,
        wakeTraceId: randomUUID(),
        forceInitPath: params.forceInitPath ?? false,
      }),
  };
}
