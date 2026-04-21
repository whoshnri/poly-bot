import type {
  GetMarketPriceParams,
  MarketPriceResponse,
} from "../types/polymarket";

export const DEFAULT_CLOB_API_URL = "https://clob.polymarket.com";

/**
 * Fetches current best market price for a token/side pair.
 */
export async function getMarketPrice({
  tokenId,
  side,
  clobApiUrl = DEFAULT_CLOB_API_URL,
  signal,
}: GetMarketPriceParams): Promise<MarketPriceResponse> {
  if (!tokenId.trim()) {
    throw new Error("tokenId is required.");
  }

  const url = new URL("/price", clobApiUrl);
  url.searchParams.set("token_id", tokenId);
  url.searchParams.set("side", side);

  const response = await fetch(url, { signal });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `CLOB getMarketPrice failed (${response.status} ${response.statusText}): ${errorText}`,
    );
  }

  const body = (await response.json()) as Partial<MarketPriceResponse>;
  if (typeof body.price !== "number" || !Number.isFinite(body.price)) {
    throw new Error("CLOB getMarketPrice returned an invalid price.");
  }

  return { price: body.price };
}
