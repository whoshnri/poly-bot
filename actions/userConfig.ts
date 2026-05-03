import prisma from "../lib/prisma";
import type { Prisma as PrismaTypes } from "../src/generated/prisma/client";
import type { UserPreferences } from "../types/db";

const DEFAULT_PREFERENCES: Required<UserPreferences> = {
  dryRun: false,
  maxOrderSizeUsdc: 100,
};

/**
 * Returns stored preferences for a Telegram user, falling back to defaults.
 */
export async function getUserPreferences(
  telegramId: string,
): Promise<Required<UserPreferences>> {
  const config = await prisma.userConfig.findUnique({
    where: { telegramId },
    select: { preferences: true },
  });

  if (!config) {
    return { ...DEFAULT_PREFERENCES };
  }

  const stored = config.preferences as Partial<UserPreferences>;
  return {
    dryRun: stored.dryRun ?? DEFAULT_PREFERENCES.dryRun,
    maxOrderSizeUsdc: stored.maxOrderSizeUsdc ?? DEFAULT_PREFERENCES.maxOrderSizeUsdc,
  };
}

/**
 * Persists a partial preference update for a Telegram user (upsert).
 * Returns the full updated preferences.
 */
export async function updateUserPreferences(
  telegramId: string,
  patch: Partial<UserPreferences>,
): Promise<Required<UserPreferences>> {
  const current = await getUserPreferences(telegramId);
  const updated: Required<UserPreferences> = { ...current, ...patch };

  await prisma.userConfig.upsert({
    where: { telegramId },
    create: {
      telegramId,
      preferences: updated as PrismaTypes.InputJsonValue,
    },
    update: {
      preferences: updated as PrismaTypes.InputJsonValue,
    },
  });

  return updated;
}
