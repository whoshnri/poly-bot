import type { OpenOrderRecord } from "../types/tools";
import { initPolymarketClient } from "./init-client";

export type GetOpenOrdersInput = {
  tokenId?: string;
  marketId?: string;
};

/**
 * Fetches current open orders from the authenticated account.
 */
export async function getOpenOrders({
  tokenId,
  marketId,
}: GetOpenOrdersInput = {}): Promise<OpenOrderRecord[]> {
  if (tokenId !== undefined && !tokenId.trim()) {
    throw new Error("tokenId must not be empty when provided.");
  }

  if (marketId !== undefined && !marketId.trim()) {
    throw new Error("marketId must not be empty when provided.");
  }

  const client = await initPolymarketClient();
  const response = (await client.getOpenOrders({
    asset_id: tokenId,
    market: marketId,
  })) as unknown;

  if (!Array.isArray(response)) {
    throw new Error("getOpenOrders returned a non-array response.");
  }

  return response as OpenOrderRecord[];
}
