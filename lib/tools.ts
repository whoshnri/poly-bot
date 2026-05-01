import { saveTargetToken, updateTargetToken } from "../actions/session";
import {
  cancelUnwantedOrder,
  getMarketById,
  getMarketPrice,
  getMarkets,
  getOpenOrders,
} from "../polymarket-endpoint";
import type {
  ToolConfigMap,
  ToolExecutorConfig,
  ToolResponse,
  ToolResultMap,
  ToolSlug,
} from "../types/tools";

/**
 * Human-readable tool descriptions exposed to the model.
 */
export const tools: Record<ToolSlug, string> = {
  "get-markets": "Fetch Gamma markets with optional filters.",
  "get-market-by-id": "Fetch one Gamma market by ID.",
  "get-market-price": "Fetch token market price from CLOB.",
  "get-open-orders": "Fetch current open orders from CLOB with optional token/market filters.",
  "save-target-token": "Persist a new target token for the working session.",
  "update-target-token": "Update the target token for the working session.",
  "cancel-unwanted-order": "Cancel one open order by order ID after existence validation.",
};

/**
 * Builds a newline-delimited tools list for prompt inclusion.
 */
export function buildToolsListDefinition(): string {
  const entries = Object.entries(tools);
  const lines = entries.map(([toolName, toolDescription]) => `- ${toolName}: ${toolDescription}`);
  return ["Tools available:", ...lines].join("\n");
}

/**
 * Creates a standardized success response for tool execution.
 */
function toToolResponse<TData>(message: string, data: TData): ToolResponse<TData> {
  return {
    status: "success",
    message,
    data,
  };
}

/**
 * Creates a standardized error response for tool execution failures.
 */
function toToolErrorResponse(error: unknown): ToolResponse<never> {
  if (error instanceof Error) {
    return {
      status: "error",
      message: "Tool execution failed.",
      data: null,
      error: {
        name: error.name,
        details: error.message,
      },
    };
  }

  return {
    status: "error",
    message: "Tool execution failed with a non-Error throw value.",
    data: null,
    error: {
      name: "UnknownError",
      details: String(error),
    },
  };
}

/**
 * Executes a tool by slug and forwards config to the underlying endpoint/action function.
 */
export async function executeTool(
  toolSlug: ToolSlug,
  config: ToolExecutorConfig,
): Promise<ToolResultMap[ToolSlug]> {
  try {
    switch (toolSlug) {
      case "get-markets": {
        const result = await getMarkets(config as ToolConfigMap["get-markets"]);
        return toToolResponse(
          `Fetched ${result.markets.length} market(s).`,
          result,
        ) as ToolResultMap[ToolSlug];
      }
      case "get-market-by-id": {
        const result = await getMarketById(config as ToolConfigMap["get-market-by-id"]);
        return toToolResponse(`Fetched market ${result.id}.`, result) as ToolResultMap[ToolSlug];
      }
      case "get-market-price": {
        const result = await getMarketPrice(config as ToolConfigMap["get-market-price"]);
        return toToolResponse(`Fetched market price: ${result.price}.`, result) as ToolResultMap[ToolSlug];
      }
      case "get-open-orders": {
        const result = await getOpenOrders(config as ToolConfigMap["get-open-orders"]);
        return toToolResponse(`Fetched ${result.length} open order(s).`, result) as ToolResultMap[ToolSlug];
      }
      case "save-target-token": {
        const result = await saveTargetToken(config as ToolConfigMap["save-target-token"]);
        return toToolResponse("Target token saved.", result) as ToolResultMap[ToolSlug];
      }
      case "update-target-token": {
        const result = await updateTargetToken(config as ToolConfigMap["update-target-token"]);
        return toToolResponse("Target token updated.", result) as ToolResultMap[ToolSlug];
      }
      case "cancel-unwanted-order": {
        const result = await cancelUnwantedOrder(
          (config as ToolConfigMap["cancel-unwanted-order"]).orderId,
        );
        return toToolResponse(`Cancelled order ${result.orderId}.`, result) as ToolResultMap[ToolSlug];
      }
      default: {
        const unsupportedTool = toolSlug satisfies never;
        throw new Error(`Unsupported tool slug: ${unsupportedTool}`);
      }
    }
  } catch (error) {
    return toToolErrorResponse(error) as ToolResultMap[ToolSlug];
  }
}
