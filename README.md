# polymarket-bot

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.12. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Tool executor entrypoint

`lib/tools.ts` is the model-facing tool entrypoint.

1. `tools` exposes the available tool slugs and descriptions.
2. `executeTool(toolSlug, config)` routes to the corresponding implementation in `polymarket-endpoint/*`.
3. `config` is a union over all tool parameter shapes.

## Shared types

All app-level interfaces and type aliases live under root `types/` and are imported where needed.

## Polymarket two-level auth client initialization

`polymarket-endpoint/init-client.ts` wraps the L1 -> L2 auth flow into one function:

1. `initPolymarketClient()` can be called with no args for a ready-to-use client.
2. It builds a signer from env (`POLYMARKET_PRIVATE_KEY`) when signer is not passed.
3. It derives API credentials through L1 auth, then returns an authenticated L2 `ClobClient`.

This repo now uses Polymarket's TypeScript SDK clients directly for auth and order flows.

`polymarket-endpoint/client-guard.ts` adds a bootstrap guardrail:

1. `assertPolymarketClientReady({ client })` performs a lightweight health check (`getOk()`).
2. It throws immediately if the client/session is not usable.

`polymarket-endpoint/createOrder.ts` provides a strictly typed reusable helper:

1. `createOrder({ client, order, options, orderType, deferExecution, postOnly })`
2. It signs the `UserOrder` with the SDK client.
3. It posts the signed order with the selected order type.
4. `createMarketOrder({ client, order, options, orderType, deferExecution })` wraps `createAndPostMarketOrder(...)` for market-order format (`OrderType.FOK`/`OrderType.FAK`).

`polymarket-endpoint/getMarkets.ts` provides plug-and-use market read helpers:

1. `getMarkets({ limit, afterCursor, order, ascending, closed, clobTokenIds, gammaApiUrl })` uses Gamma `/markets/keyset`.
2. `getMarketById({ marketId, gammaApiUrl })` fetches a single market by ID from Gamma.

`polymarket-endpoint/getMarketPrice.ts` provides a market price helper:

1. `getMarketPrice({ tokenId, side, clobApiUrl })`
2. Uses CLOB `GET /price` with `side: "BUY" | "SELL"` and returns `{ price: number }`.

`polymarket-endpoint/getOpenOrders.ts` and `polymarket-endpoint/cancelOrder.ts` provide order-management helpers:

1. `getOpenOrders({ tokenId, marketId })` reads live CLOB open orders (source of truth for idempotency/recovery checks).
2. `cancelUnwantedOrder(orderId)` validates the order exists in current open orders, then cancels that specific order.

## Heartbeat (L2 session keep-alive)

`polymarket-endpoint/heartbeat.ts` provides reusable heartbeat helpers for automated bots:

1. `sendHeartbeat({ client, heartbeatId })` sends `POST /heartbeat`.
2. `runHeartbeatLoop({ client, intervalMs, initialHeartbeatId, signal, onHeartbeat })` runs heartbeat in a loop (default every 8 seconds).
3. The loop stores and reuses the latest `heartbeat_id` from each response.

Important behavior:

1. If heartbeat is not received in time, open orders can be automatically cancelled by the exchange.
2. First request can start with `initialHeartbeatId: null` (or omitted).
3. If the server reports an invalid/expired heartbeat ID, restart the chain with the returned ID from the server response.

Operational note: the `ClobClient` stays alive only for the lifetime of the running process. You should initialize one client once in your heartbeat worker process and reuse it for all heartbeat calls, rather than recreating it on every tick.

## Stage-action safety hardening

`ai/index.ts` now applies stricter execution guardrails:

1. Per-wake trace lock: stage actions acquire a session lock before side effects and release it in `finally`.
2. START_TRADE idempotency: checks live open orders by token before placing and loops back to model if an order already exists.
3. START_TRADE atomicity: if order placement succeeds but metadata persistence fails, it attempts immediate rollback cancellation.
4. END_TRADE recovery: cancels the stored order when available and falls back to `cancelAll()` when session metadata is missing.
5. Stage persistence: every model response is persisted as a `SessionStage`; stages start with `stageActionCompleted=false` and are marked `true` after successful side-effect execution.
6. Intent freezing: first validated START_TRADE order shape is retained in graph state and reused across retries.

### Signature type and funder defaults

`initPolymarketClient(...)` resolves these automatically for the default path:

1. `signatureType` defaults to `0` (EOA) and can be overridden by `POLYMARKET_SIGNATURE_TYPE` (`0 | 1 | 2`) or function config.
2. `funderAddress` is derived from signer when not explicitly provided.
3. `host` defaults to `https://clob.polymarket.com` and can be overridden with `POLYMARKET_HOST`.
4. `chain` defaults to Polygon (`137`) and can be overridden with `POLYMARKET_CHAIN_ID` in config/env.

| Signature Type | Value | Description |
| --- | --- | --- |
| EOA | `0` | Standard Ethereum wallet (MetaMask). Set `funderAddress` to the EOA wallet address. This wallet must hold POL to pay gas for transactions. |
| POLY_PROXY | `1` | Custom proxy wallet used for users authenticated via Magic Link email/Google. Requires the user to export their private key from Polymarket.com and import it into your app. |
| GNOSIS_SAFE | `2` | Gnosis Safe multisig proxy wallet (most common). Use for new or returning users who do not fit the other two wallet types. |
