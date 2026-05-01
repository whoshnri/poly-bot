import {
  Chain,
  ClobClient,
  type ApiKeyCreds,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { TwoLevelAuthConfig } from "../types/polymarket";

/** 
 * 
 * Helper variables
 * 
*/
const HOST = "https://clob.polymarket.com";
const CHAIN_ID = Chain.POLYGON; // Polygon mainnet

type InitPolymarketClientConfig = Partial<TwoLevelAuthConfig>;

function resolveChainId(chainId?: TwoLevelAuthConfig["chainId"]): Chain {
  if (chainId !== undefined) {
    return chainId;
  }

  const fromEnv = process.env.POLYMARKET_CHAIN_ID;
  if (fromEnv === undefined) {
    return CHAIN_ID;
  }

  const parsed = Number(fromEnv);
  if (!Number.isInteger(parsed)) {
    throw new Error("POLYMARKET_CHAIN_ID must be an integer.");
  }

  return parsed as Chain;
}

function resolveHost(host?: TwoLevelAuthConfig["host"]): string {
  return host ?? process.env.POLYMARKET_HOST ?? HOST;
}

function resolveSignatureType(
  signatureType?: TwoLevelAuthConfig["signatureType"],
): NonNullable<TwoLevelAuthConfig["signatureType"]> {
  if (signatureType !== undefined) {
    return signatureType;
  }

  const fromEnv = process.env.POLYMARKET_SIGNATURE_TYPE;
  if (fromEnv === undefined) {
    return 0;
  }

  if (fromEnv === "0" || fromEnv === "1" || fromEnv === "2") {
    return Number(fromEnv) as NonNullable<TwoLevelAuthConfig["signatureType"]>;
  }

  throw new Error("POLYMARKET_SIGNATURE_TYPE must be one of: 0, 1, 2.");
}

function getRequiredPrivateKey(): `0x${string}` {
  const key = process.env.POLYMARKET_PRIVATE_KEY;
  if (!key) {
    throw new Error("POLYMARKET_PRIVATE_KEY is required.");
  }

  if (!key.startsWith("0x")) {
    throw new Error("POLYMARKET_PRIVATE_KEY must start with 0x.");
  }

  return key as `0x${string}`;
}

async function resolveFunderAddress(
  signer: TwoLevelAuthConfig["signer"],
  funderAddress?: TwoLevelAuthConfig["funderAddress"],
): Promise<string> {
  if (funderAddress) {
    return funderAddress;
  }

  if ("getAddress" in signer && typeof signer.getAddress === "function") {
    return signer.getAddress();
  }

  if ("account" in signer && signer.account?.address) {
    return signer.account.address;
  }

  if ("getAddresses" in signer && typeof signer.getAddresses === "function") {
    const addresses = await signer.getAddresses();
    const [address] = addresses;
    if (address) {
      return address;
    }
  }

  throw new Error("Unable to resolve funderAddress from signer.");
}

/**
 * Creates or derives API credentials using L1 auth.
 */
async function createOrDeriveApiCreds(config: {
  host: string;
  chain: Chain;
  signer: TwoLevelAuthConfig["signer"];
}): Promise<ApiKeyCreds> {
  const tempClient = new ClobClient({
    host: config.host,
    chain: config.chain,
    signer: config.signer,
  });
  return tempClient.createOrDeriveApiKey();
}

/**
 * Initializes an authenticated L2 Polymarket CLOB client.
 * With no args, it builds a signer from env and returns a ready-to-use client.
 */
export async function initPolymarketClient(
  config: InitPolymarketClientConfig = {},
): Promise<ClobClient> {
  const host = resolveHost(config.host);
  const chain = resolveChainId(config.chainId);
  const signatureType = resolveSignatureType(config.signatureType);

  const signer =
    config.signer ??
    createWalletClient({
      account: privateKeyToAccount(getRequiredPrivateKey()),
      chain: polygon,
      transport: http(),
    });

  if (!config.signer && chain !== Chain.POLYGON) {
    throw new Error("Default signer setup currently supports only Polygon (chain 137).");
  }

  const funderAddress = await resolveFunderAddress(signer, config.funderAddress);

  const apiCreds = await createOrDeriveApiCreds({
    host,
    chain,
    signer,
  });

  const client = new ClobClient({
    host,
    chain,
    signer,
    creds: apiCreds,
    signatureType,
    funderAddress,
  });

  return client;
}
