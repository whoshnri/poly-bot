import type { CancelUnwantedOrderResult, OpenOrderRecord } from "../types/tools";
import { initPolymarketClient } from "./init-client";

/**
 * Cancels one order only when it exists in current open orders.
 */
export async function cancelUnwantedOrder(orderId: string): Promise<CancelUnwantedOrderResult> {
  if (!orderId.trim()) {
    throw new Error("orderId is required.");
  }

  const client = await initPolymarketClient();
  const openOrders = (await client.getOpenOrders()) as unknown;

  if (!Array.isArray(openOrders)) {
    throw new Error("Unable to validate open orders before cancellation.");
  }

  const match = (openOrders as OpenOrderRecord[]).find((order) => order.id === orderId);
  if (!match) {
    throw new Error(`Order ${orderId} is not in current open orders.`);
  }

  const cancelled = await client.cancelOrder({ orderID: orderId });
  return { orderId, cancelled };
}
