import type { AiModelResponse } from "./aiSchemas";
import type { ToolResponse } from "./tools";

export type AiGraphMessage = {
  role: "server" | "ai";
  content: string;
  timestamp: string;
};

export type CompileTradingGraphParams = {
  sessionId?: string;
  forceInitPath?: boolean;
};

export type TradingGraphNodeState = {
  sessionId: string | null;
  wakeTraceId: string | null;
  forceInitPath: boolean;
  prompt: string;
  messages: AiGraphMessage[];
  aiResponse: AiModelResponse | null;
  intendedStartTradeOrder: {
    tokenId: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
  } | null;
  toolResults: ToolResponse<unknown>[];
  stageActionComplete: boolean;
  stopReason: string | null;
  // --> changes start here
  /** Counts how many tool-call rounds have completed in this wake cycle. Used to break infinite loops. */
  toolCallIteration: number;
  // --> changes end here
};
