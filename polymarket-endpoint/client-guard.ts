import type { AssertPolymarketClientReadyParams } from "../types/polymarket";

/**
 * Ensures the initialized Polymarket client is reachable before use.
 */
export async function assertPolymarketClientReady({
  client,
}: AssertPolymarketClientReadyParams): Promise<void> {
  await client.getOk();
}
