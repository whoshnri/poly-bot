import { readFileSync } from "node:fs";
import { join } from "node:path";

export type TradeGuardrails = {
  maxOrderSizeUsdc: number;
  maxExposureUsdc: number;
  allowedSides: ("BUY" | "SELL")[];
  minPrice: number;
  maxPrice: number;
  dryRun: boolean;
};

export type BotConfig = {
  maxRetriesPerStage: number;
  tradeGuardrails: TradeGuardrails;
};

const CONFIG_PATH = join(import.meta.dir, "../ai/config.json");

const defaults: BotConfig = {
  maxRetriesPerStage: 3,
  tradeGuardrails: {
    maxOrderSizeUsdc: 100,
    maxExposureUsdc: 500,
    allowedSides: ["BUY", "SELL"],
    minPrice: 0.01,
    maxPrice: 0.99,
    dryRun: false,
  },
};

function loadConfig(): BotConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BotConfig>;
    return {
      maxRetriesPerStage: parsed.maxRetriesPerStage ?? defaults.maxRetriesPerStage,
      tradeGuardrails: {
        ...defaults.tradeGuardrails,
        ...parsed.tradeGuardrails,
      },
    };
  } catch {
    console.warn("[config] Failed to load ai/config.json, using defaults.");
    return defaults;
  }
}

export const botConfig: BotConfig = loadConfig();

/**
 * Formats guardrail constraints as a human-readable string for prompt inclusion.
 */
export function buildGuardrailsDescription(): string {
  const g = botConfig.tradeGuardrails;
  const lines = [
    "Operator-configured trade guardrails (MUST be respected at all times):",
    `- Max single order size: $${g.maxOrderSizeUsdc} USDC`,
    `- Max total exposure: $${g.maxExposureUsdc} USDC`,
    `- Allowed sides: ${g.allowedSides.join(", ")}`,
    `- Price range: ${g.minPrice} – ${g.maxPrice}`,
    `- Dry-run mode: ${g.dryRun ? "ENABLED (no real orders will be placed)" : "disabled (live trading active)"}`,
    `- Max retries per stage: ${botConfig.maxRetriesPerStage}`,
  ];
  return lines.join("\n");
}
