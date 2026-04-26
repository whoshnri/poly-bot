import { saveTargetToken, updateTargetToken } from "../actions/session";
// --> changes start here
import { readNewsArticle, searchNews } from "../news-endpoint";
// --> changes end here
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
  // --> changes start here
  "search-news":
    "Search for recent news via Jina Search (s.jina.ai). " +
    "Use ONLY when the sentimental market you are analysing involves real-world events " +
    "(e.g. wars, elections, government decisions) and you need current news context. " +
    "Provide a focused query and the desired language (hl). pageSize defaults to 5 — " +
    "use the minimum needed. Results include title, url, description, and date; " +
    "article bodies are omitted to save tokens. Follow up with read-news-article for full text.",
  "read-news-article":
    "Fetch full Markdown article content via Jina Reader (r.jina.ai). " +
    "Only call this for specific URLs returned by search-news — do not fabricate URLs. " +
    "Read at most 1-2 articles per reasoning cycle to stay within rate limits. " +
    "The response includes the article body and an extracted links[] array " +
    "you can use for deeper context if needed.",
  // --> changes end here
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
      // --> changes start here
      case "search-news": {
        const result = await searchNews(config as ToolConfigMap["search-news"]);
        return toToolResponse(
          `Fetched ${result.results.length} news result(s).`,
          result,
        ) as ToolResultMap[ToolSlug];
      }
      case "read-news-article": {
        const result = await readNewsArticle(config as ToolConfigMap["read-news-article"]);
        return toToolResponse(
          `Fetched article: "${result.title ?? result.url}" (${result.links.length} link(s) extracted).`,
          result,
        ) as ToolResultMap[ToolSlug];
      }
      // --> changes end here
      default: {
        const unsupportedTool = toolSlug satisfies never;
        throw new Error(`Unsupported tool slug: ${unsupportedTool}`);
      }
    }
  } catch (error) {
    return toToolErrorResponse(error) as ToolResultMap[ToolSlug];
  }
}
