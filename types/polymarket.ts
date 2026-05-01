import type {
  Chain,
  ClobClient,
  ClobSigner,
  CreateOrderOptions,
  HeartbeatResponse,
  UserMarketOrder,
  UserOrder,
} from "@polymarket/clob-client";
import type { OrderType } from "@polymarket/clob-client";

export type TwoLevelAuthConfig = {
  host?: string;
  chainId?: Chain;
  signer: ClobSigner;
  signatureType?: 0 | 1 | 2;
  funderAddress: string;
};

export type AssertPolymarketClientReadyParams = {
  client: ClobClient;
};

export type CreateOrderParams = {
  client: ClobClient;
  order: UserOrder;
  options?: Partial<CreateOrderOptions>;
  orderType?: OrderType.GTC | OrderType.GTD;
  deferExecution?: boolean;
  postOnly?: boolean;
};

export type CreateMarketOrderParams = {
  client: ClobClient;
  order: UserMarketOrder;
  options?: Partial<CreateOrderOptions>;
  orderType?: OrderType.FOK | OrderType.FAK;
  deferExecution?: boolean;
};

export type MarketPriceResponse = {
  price: number;
};

export type MarketSide = "BUY" | "SELL";

export type GetMarketPriceParams = {
  tokenId: string;
  side: MarketSide;
  clobApiUrl?: string;
  signal?: AbortSignal;
};

export type GammaRequestOptions = {
  gammaApiUrl?: string;
  signal?: AbortSignal;
};

export type GammaMarket = {
  id: string;
  question?: string;
  slug?: string;
  clobTokenIds?: string;
  bestBid?: number | string;
  bestAsk?: number | string;
  [key: string]: unknown;
};

export type GetMarketsResponse<TMarket = GammaMarket> = {
  markets: TMarket[];
  next_cursor?: string;
};

export type GetMarketsParams = GammaRequestOptions & {
  limit?: number;
  afterCursor?: string;
  order?: string;
  ascending?: boolean;
  closed?: boolean;
  clobTokenIds?: string[];
};

export type GetMarketByIdParams = GammaRequestOptions & {
  marketId: string;
};

export type SendHeartbeatParams = {
  client: ClobClient;
  heartbeatId?: string | null;
};

export type RunHeartbeatLoopParams = {
  client: ClobClient;
  intervalMs?: number;
  initialHeartbeatId?: string | null;
  signal?: AbortSignal;
  onHeartbeat?: (response: HeartbeatResponse) => void;
};
