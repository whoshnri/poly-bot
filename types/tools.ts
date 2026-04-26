import type {
  GammaMarket,
  GetMarketByIdParams,
  GetMarketPriceParams,
  GetMarketsParams,
  GetMarketsResponse,
  MarketPriceResponse,
} from "./polymarket";

// --> changes start here
// ─── News / Jina types ────────────────────────────────────────────────────────

/**
 * Parameters the model provides when calling search-news.
 * The API key is never included here — it is read from JINA_API_KEY env var only.
 */
export type SearchNewsParams = {
  /** Focused search query, e.g. "Ukraine war ceasefire negotiations 2025". */
  query: string;
  /** BCP-47 language code for result language. Defaults to "en". */
  hl?: string;
  /**
   * Number of results to return (1-10, default 5).
   * Use the smallest number that gives enough signal to reason about the market.
   */
  pageSize?: number;
};

/** One news result entry as returned by s.jina.ai (content body omitted via X-Respond-With). */
export type JinaSearchResult = {
  title: string;
  url: string;
  description?: string;
  date?: string;
  source?: string;
  favicon?: string;
};

/** Structured response from search-news. */
export type SearchNewsResponse = {
  results: JinaSearchResult[];
};

/**
 * Parameters the model provides when calling read-news-article.
 * Always use URLs returned by search-news — do not fabricate URLs.
 */
export type ReadNewsArticleParams = {
  /** Full http/https URL of the article to read. Must come from search-news results. */
  url: string;
};

/** One extracted hyperlink from an article — useful for recursive deep-dives. */
export type NewsArticleLink = {
  text: string;
  url: string;
};

/** Full article content as returned by r.jina.ai. */
export type NewsArticleContent = {
  title?: string;
  url: string;
  /** Full article text in Markdown. Summarise key points; do not dump the whole thing. */
  content: string;
  /** Hyperlinks extracted from the article. Use sparingly for deeper context only. */
  links: NewsArticleLink[];
};
// --> changes end here

export type TargetTokenPayload = {
  tokenId: string;
  marketId?: string;
  note?: string;
  savedAt: string;
};

export type SaveTargetTokenParams = {
  sessionId: string;
  tokenId: string;
  marketId?: string;
  note?: string;
};

export type UpdateTargetTokenParams = {
  sessionId: string;
  tokenId: string;
  marketId?: string;
  note?: string;
};

export type GetOpenOrdersParams = {
  tokenId?: string;
  marketId?: string;
};

export type OpenOrderRecord = {
  id: string;
  asset_id?: string;
  market?: string;
  side?: string;
  price?: string;
  original_size?: string;
  size_matched?: string;
  status?: string;
};

export type CancelUnwantedOrderParams = {
  orderId: string;
};

export type CancelUnwantedOrderResult = {
  orderId: string;
  cancelled: unknown;
};

export type ToolSlug =
  | "get-markets"
  | "get-market-by-id"
  | "get-market-price"
  | "get-open-orders"
  | "save-target-token"
  | "update-target-token"
  | "cancel-unwanted-order"
  // --> changes start here
  | "search-news"
  | "read-news-article";
  // --> changes end here

export type ToolConfigMap = {
  "get-markets": GetMarketsParams;
  "get-market-by-id": GetMarketByIdParams;
  "get-market-price": GetMarketPriceParams;
  "get-open-orders": GetOpenOrdersParams;
  "save-target-token": SaveTargetTokenParams;
  "update-target-token": UpdateTargetTokenParams;
  "cancel-unwanted-order": CancelUnwantedOrderParams;
  // --> changes start here
  "search-news": SearchNewsParams;
  "read-news-article": ReadNewsArticleParams;
  // --> changes end here
};

export type ToolSuccessResponse<TData> = {
  status: "success";
  message: string;
  data: TData;
};

export type ToolErrorResponse = {
  status: "error";
  message: string;
  data: null;
  error: {
    name: string;
    details?: string;
  };
};

export type ToolResponse<TData> = ToolSuccessResponse<TData> | ToolErrorResponse;

export type ToolResultMap = {
  "get-markets": ToolResponse<GetMarketsResponse<GammaMarket>>;
  "get-market-by-id": ToolResponse<GammaMarket>;
  "get-market-price": ToolResponse<MarketPriceResponse>;
  "get-open-orders": ToolResponse<OpenOrderRecord[]>;
  "save-target-token": ToolResponse<TargetTokenPayload>;
  "update-target-token": ToolResponse<TargetTokenPayload>;
  "cancel-unwanted-order": ToolResponse<CancelUnwantedOrderResult>;
  // --> changes start here
  "search-news": ToolResponse<SearchNewsResponse>;
  "read-news-article": ToolResponse<NewsArticleContent>;
  // --> changes end here
};

export type ToolExecutorConfig = ToolConfigMap[ToolSlug];
