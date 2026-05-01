import {
  OrderType,
} from "@polymarket/clob-client";
import type {
  CreateMarketOrderParams,
  CreateOrderParams,
} from "../types/polymarket";

/**
 * Signs and posts a limit order using an authenticated Polymarket client.
 */
export async function createOrder({
  client,
  order,
  options,
  orderType = OrderType.GTC,
  deferExecution = false,
  postOnly = false,
}: CreateOrderParams): Promise<unknown> {
  const signedOrder = await client.createOrder(order, options);
  return client.postOrder(signedOrder, orderType, deferExecution, postOnly);
}

/**
 * Creates and posts a market order in one call.
 */
export async function createMarketOrder({
  client,
  order,
  options,
  orderType = OrderType.FOK,
  deferExecution = false,
}: CreateMarketOrderParams): Promise<unknown> {
  return client.createAndPostMarketOrder(
    order,
    options,
    orderType,
    deferExecution,
  );
}
