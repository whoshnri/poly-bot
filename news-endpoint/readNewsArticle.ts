// --> changes start here
// Jina Reader API wrapper (https://r.jina.ai/)
// Fetches clean Markdown article content + extracted links for a single URL.
// The model supplies the URL; the API key is read from env only.
//
// DISCLAIMER: Only call this for specific, high-signal URLs returned by search-news.
// Do not crawl all search results — read only the 1-2 most relevant articles.

import type { NewsArticleContent, ReadNewsArticleParams } from "../types/tools";

// Jina Reader base URL — the target URL is appended as the path segment
const JINA_READER_BASE = "https://r.jina.ai/";

// Response envelope returned by r.jina.ai with Accept: application/json
type JinaReaderEnvelope = {
  code?: number;
  status?: number;
  data?: {
    title?: string;
    url?: string;
    content?: string;
    // Jina returns links as { "link text": "https://..." }
    links?: Record<string, string>;
  };
};

/**
 * Fetches clean Markdown article content via the Jina Reader API (r.jina.ai).
 *
 * Fixed request headers (operator config — do not override):
 *   Accept: application/json
 *   X-No-Cache: true  — always fetch a fresh read, no stale cached version
 *
 * The model provides: url (must be a valid http/https URL from search-news results).
 * JINA_API_KEY is read from process.env — never pass it through tool metadata.
 *
 * Returns: { title, url, content (Markdown), links[] }
 * The links[] array enables recursive deep-dives into related sources.
 */
export async function readNewsArticle(params: ReadNewsArticleParams): Promise<NewsArticleContent> {
  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) {
    throw new Error(
      "JINA_API_KEY is not configured. Add it to your .env file. Do not embed the key in code.",
    );
  }

  // Basic URL sanity check — must be http or https
  if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
    throw new Error(
      `read-news-article: url must start with http:// or https://. Received: "${params.url}"`,
    );
  }

  // Jina Reader appends the target URL directly as a path segment (no encoding)
  const readerUrl = `${JINA_READER_BASE}${params.url}`;

  const response = await fetch(readerUrl, {
    method: "GET",
    headers: {
      // Fixed operator headers — do not change
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-No-Cache": "true", // Always fetch fresh; this bot only needs current information
    },
  });

  // Rate-limit guard: model should stop deep-diving and reason with what it has
  if (response.status === 429) {
    throw new Error(
      "Jina Reader API rate limit exceeded (HTTP 429). " +
        "DISCLAIMER: read-news-article should only be called for 1-2 key articles per reasoning cycle. " +
        "Do not read every URL from search results. Wait at least 60 seconds before retrying.",
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(no body)");
    throw new Error(
      `Jina Reader API error: HTTP ${response.status} ${response.statusText} for "${params.url}" — ${errorText}`,
    );
  }

  const json = (await response.json()) as JinaReaderEnvelope;
  const data = json.data ?? {};

  // Jina returns links as { "link text": "https://..." } — convert to array for model
  const links = Object.entries(data.links ?? {}).map(([text, url]) => ({ text, url }));

  return {
    title: data.title,
    url: data.url ?? params.url,
    content: data.content ?? "",
    links,
  };
}
// --> changes end here
