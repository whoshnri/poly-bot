// --> changes start here
// Jina Search API wrapper (https://s.jina.ai/)
// Fixed operator headers per config: no-cache, no-content body, with favicons, JSON accept.
// The model supplies query, hl, and pageSize — the API key is read from env only.
//
// DISCLAIMER: Use this tool only when sentimental market context is genuinely required
// (e.g. wars, elections, government decisions). Avoid polling; each call costs quota.

import type { SearchNewsParams, SearchNewsResponse } from "../types/tools";

// Jina Search base URL — do not change
const JINA_SEARCH_BASE = "https://s.jina.ai/";

// Maximum results the model may request per call; keep low to limit context tokens
const JINA_MAX_PAGE_SIZE = 10;

// Response envelope returned by s.jina.ai with Accept: application/json
type JinaSearchEnvelope = {
  code?: number;
  status?: number;
  data?: Array<{
    title?: string;
    url?: string;
    description?: string;
    date?: string;
    source?: string;
    favicon?: string;
  }>;
};

/**
 * Searches for recent news using the Jina Search API (s.jina.ai).
 *
 * Fixed request headers (operator config — do not override):
 *   Accept: application/json
 *   X-No-Cache: true          — always fetch fresh results, never stale cache
 *   X-Respond-With: no-content — omit full article body; saves context tokens
 *   X-With-Favicons: true     — include source favicon in results
 *
 * The model provides: query, hl (language, default "en"), pageSize (default 5, max 10).
 * JINA_API_KEY is read from process.env — never pass it through tool metadata.
 */
export async function searchNews(params: SearchNewsParams): Promise<SearchNewsResponse> {
  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) {
    throw new Error(
      "JINA_API_KEY is not configured. Add it to your .env file. Do not embed the key in code.",
    );
  }

  // Clamp pageSize to valid range — defaults to 5 (lean context)
  const pageSize = Math.min(Math.max(params.pageSize ?? 5, 1), JINA_MAX_PAGE_SIZE);
  const hl = params.hl ?? "en";

  const requestUrl = new URL(JINA_SEARCH_BASE);
  requestUrl.searchParams.set("q", params.query);
  requestUrl.searchParams.set("hl", hl);

  const response = await fetch(requestUrl.toString(), {
    method: "GET",
    headers: {
      // Fixed operator headers — do not change order or values
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-No-Cache": "true",
      "X-Respond-With": "no-content", // Omit article bodies; use read-news-article for full text
      "X-With-Favicons": "true",
    },
  });

  // Rate-limit guard: model must back off before retrying
  if (response.status === 429) {
    throw new Error(
      "Jina Search API rate limit exceeded (HTTP 429). " +
        "DISCLAIMER: search-news should only be called when genuine sentimental market context is needed. " +
        "Do not call repeatedly in the same reasoning loop. Wait at least 60 seconds before retrying.",
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(no body)");
    throw new Error(
      `Jina Search API error: HTTP ${response.status} ${response.statusText} — ${errorText}`,
    );
  }

  const json = (await response.json()) as JinaSearchEnvelope;
  const rawResults = Array.isArray(json.data) ? json.data : [];

  return {
    // Slice to the model-requested pageSize; omit any entries without a URL
    results: rawResults
      .filter((item) => typeof item.url === "string" && item.url.length > 0)
      .slice(0, pageSize)
      .map((item) => ({
        title: item.title ?? "",
        url: item.url as string,
        description: item.description,
        date: item.date,
        source: item.source,
        favicon: item.favicon,
      })),
  };
}
// --> changes end here
