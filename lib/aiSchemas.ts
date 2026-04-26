import { z } from "zod";

/**
 * Canonical stage actions used by the AI orchestration flow.
 */
export const stageActionSchema = z.enum([
  "START_TRADE",
  "END_TRADE",
  "WAIT",
  "SKIP",
  "CLARIFY",
]);

/**
 * Decision-support tools the model can call while reasoning.
 */
export const decisionToolSchema = z.enum([
  "get-markets",
  "get-market-by-id",
  "get-market-price",
  "get-open-orders",
  "cancel-unwanted-order",
  "save-target-token",
  "update-target-token",
  // --> changes start here
  "search-news",
  "read-news-article",
  // --> changes end here
]);

const getMarketsToolMetadataSchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  afterCursor: z.string().min(1).optional(),
  order: z.string().min(1).optional(),
  ascending: z.boolean().optional(),
  closed: z.boolean().optional(),
  clobTokenIds: z.array(z.string().min(1)).optional(),
});

const getMarketByIdToolMetadataSchema = z.object({
  marketId: z.string().min(1),
});

const getMarketPriceToolMetadataSchema = z.object({
  tokenId: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
});

const getOpenOrdersToolMetadataSchema = z.object({
  tokenId: z.string().min(1).optional(),
  marketId: z.string().min(1).optional(),
});

const cancelUnwantedOrderToolMetadataSchema = z.object({
  orderId: z.string().min(1),
});

const tokenMutationToolMetadataSchema = z.object({
  sessionId: z.uuid().optional(),
  tokenId: z.string().min(1),
  marketId: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
});

// --> changes start here
/**
 * search-news: model-supplied parameters for Jina Search (s.jina.ai).
 * API key is NOT here — it lives in JINA_API_KEY env var only.
 * Use only for sentimental markets where news context is required.
 */
const searchNewsToolMetadataSchema = z.object({
  /** Focused search query, e.g. "Ukraine ceasefire talks April 2025". */
  query: z.string().min(1),
  /** BCP-47 language code. Defaults to "en". */
  hl: z.string().min(2).max(10).optional(),
  /**
   * Number of results to return (1–10, default 5).
   * Use the minimum needed — smaller values reduce context token usage.
   */
  pageSize: z.number().int().min(1).max(10).optional(),
});

/**
 * read-news-article: model-supplied URL to fetch via Jina Reader (r.jina.ai).
 * Only use URLs returned by search-news — do not fabricate URLs.
 * Read at most 1-2 articles per reasoning cycle to stay within rate limits.
 */
const readNewsArticleToolMetadataSchema = z.object({
  /** Full http/https article URL from a search-news result. */
  url: z.string().url(),
});
// --> changes end here


/**
 * One model tool call request with strictly typed metadata by tool slug.
 */
export const toolCallSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("get-markets"),
    reason: z.string().min(1),
    metadata: getMarketsToolMetadataSchema,
  }),
  z.object({
    tool: z.literal("get-market-by-id"),
    reason: z.string().min(1),
    metadata: getMarketByIdToolMetadataSchema,
  }),
  z.object({
    tool: z.literal("get-market-price"),
    reason: z.string().min(1),
    metadata: getMarketPriceToolMetadataSchema,
  }),
  z.object({
    tool: z.literal("get-open-orders"),
    reason: z.string().min(1),
    metadata: getOpenOrdersToolMetadataSchema,
  }),
  z.object({
    tool: z.literal("cancel-unwanted-order"),
    reason: z.string().min(1),
    metadata: cancelUnwantedOrderToolMetadataSchema,
  }),
  z.object({
    tool: z.literal("save-target-token"),
    reason: z.string().min(1),
    metadata: tokenMutationToolMetadataSchema,
  }),
  z.object({
    tool: z.literal("update-target-token"),
    reason: z.string().min(1),
    metadata: tokenMutationToolMetadataSchema,
  }),
  // --> changes start here
  z.object({
    tool: z.literal("search-news"),
    reason: z.string().min(1),
    metadata: searchNewsToolMetadataSchema,
  }),
  z.object({
    tool: z.literal("read-news-article"),
    reason: z.string().min(1),
    metadata: readNewsArticleToolMetadataSchema,
  }),
  // --> changes end here
]);

const startTradeActionDataSchema = z.object({
  reason: z.string().min(1),
  resumeAt: z.iso.datetime(),
  order: z.object({
    tokenId: z.string().min(1),
    side: z.enum(["BUY", "SELL"]),
    price: z.number().positive(),
    size: z.number().positive(),
  }),
});

const endTradeActionDataSchema = z.object({
  reason: z.string().min(1),
});

const waitActionDataSchema = z.object({
  reason: z.string().min(1),
  resumeAt: z.iso.datetime(),
});

const skipActionDataSchema = z.object({
  reason: z.string().min(1),
});

const clarifyActionDataSchema = z.object({
  reason: z.string().min(1),
  userMessageHtml: z.string().min(1),
  resumeAt: z.iso.datetime(),
});

/**
 * Single next-stage payload. This stores only the next stage, never previous/future lists.
 */
export const nextStageSchema = z.object({
  summary: z.string().min(1),
  todo: z.string().min(1),
  stageAction: stageActionSchema.nullable(),
  stageActionData: z.union([
    startTradeActionDataSchema,
    endTradeActionDataSchema,
    waitActionDataSchema,
    skipActionDataSchema,
    clarifyActionDataSchema,
    z.null(),
  ]),
});

/**
 * Structured AI response consumed by the graph.
 */
export const aiModelResponseSchema = z
  .object({
    message: z.string().min(1),
    isTradeActive: z.boolean(),
    toolCalls: z.array(toolCallSchema).default([]),
    nextStage: nextStageSchema,
  })
  .superRefine((value, ctx) => {
    const { stageAction, stageActionData } = value.nextStage;

    if (stageAction === null) {
      if (stageActionData !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nextStage", "stageActionData"],
          message: "stageActionData must be null when stageAction is null.",
        });
      }

      return;
    }

    if (stageActionData === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextStage", "stageActionData"],
        message: "stageActionData is required when stageAction is set.",
      });
      return;
    }

    const validators = {
      START_TRADE: startTradeActionDataSchema,
      END_TRADE: endTradeActionDataSchema,
      WAIT: waitActionDataSchema,
      SKIP: skipActionDataSchema,
      CLARIFY: clarifyActionDataSchema,
    } as const;

    const result = validators[stageAction].safeParse(stageActionData);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ["nextStage", "stageActionData", ...issue.path],
        });
      }
    }
  });
