import type {
  GammaMarket,
  GetMarketByIdParams,
  GetMarketsParams,
  GetMarketsResponse,
} from "../types/polymarket";

export const DEFAULT_GAMMA_API_URL = "https://gamma-api.polymarket.com";

/**
 * Builds a Gamma API URL with validated query parameters.
 */
function buildGammaUrl(
  path: string,
  query: Record<string, string | number | boolean | string[] | undefined>,
  gammaApiUrl: string,
): string {
  const url = new URL(path, gammaApiUrl);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

/**
 * Fetches markets from Gamma's keyset endpoint.
 */
export async function getMarkets<TMarket = GammaMarket>({
  limit,
  afterCursor,
  order,
  ascending,
  closed,
  clobTokenIds,
  gammaApiUrl = DEFAULT_GAMMA_API_URL,
  signal,
}: GetMarketsParams): Promise<GetMarketsResponse<TMarket>> {
  if (limit !== undefined && (limit < 1 || limit > 1000)) {
    throw new Error("limit must be between 1 and 1000.");
  }

  const url = buildGammaUrl(
    "/markets/keyset",
    {
      limit,
      after_cursor: afterCursor,
      order,
      ascending,
      closed,
      clob_token_ids: clobTokenIds,
    },
    gammaApiUrl,
  );

  const response = await fetch(url, { signal });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Gamma getMarkets failed (${response.status} ${response.statusText}): ${errorText}`,
    );
  }

  return (await response.json()) as GetMarketsResponse<TMarket>;
}

/**
 * Fetches one market by its Gamma market ID.
 */
export async function getMarketById<TMarket = GammaMarket>({
  marketId,
  gammaApiUrl = DEFAULT_GAMMA_API_URL,
  signal,
}: GetMarketByIdParams): Promise<TMarket> {
  if (!marketId.trim()) {
    throw new Error("marketId is required.");
  }

  const url = new URL(`/markets/${encodeURIComponent(marketId)}`, gammaApiUrl);
  const response = await fetch(url, { signal });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Gamma getMarketById failed (${response.status} ${response.statusText}): ${errorText}`,
    );
  }

  return (await response.json()) as TMarket;
}
