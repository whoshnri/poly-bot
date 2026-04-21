import prisma from "../lib/prisma";
import type {
  SaveTargetTokenParams,
  TargetTokenPayload,
  UpdateTargetTokenParams,
} from "../types/tools";

/**
 * Saves a new target token payload into session metadata.
 */
export async function saveTargetToken(params: SaveTargetTokenParams): Promise<TargetTokenPayload> {
  const existingSession = await prisma.session.findUnique({
    where: { id: params.sessionId },
    select: { metadata: true },
  });

  if (!existingSession) {
    throw new Error(`Session not found: ${params.sessionId}`);
  }

  const existingMetadata =
    existingSession.metadata && typeof existingSession.metadata === "object"
      ? (existingSession.metadata as Record<string, unknown>)
      : {};

  if (existingMetadata.targetToken) {
    throw new Error("Target token already exists. Use update-target-token instead.");
  }

  const payload: TargetTokenPayload = {
    tokenId: params.tokenId,
    marketId: params.marketId,
    note: params.note,
    savedAt: new Date().toISOString(),
  };

  await prisma.session.update({
    where: { id: params.sessionId },
    data: {
      metadata: {
        ...existingMetadata,
        targetToken: payload,
      },
    },
  });

  return payload;
}

/**
 * Updates an existing target token payload in session metadata.
 */
export async function updateTargetToken(
  params: UpdateTargetTokenParams,
): Promise<TargetTokenPayload> {
  const existingSession = await prisma.session.findUnique({
    where: { id: params.sessionId },
    select: { metadata: true },
  });

  if (!existingSession) {
    throw new Error(`Session not found: ${params.sessionId}`);
  }

  const existingMetadata =
    existingSession.metadata && typeof existingSession.metadata === "object"
      ? (existingSession.metadata as Record<string, unknown>)
      : {};

  const payload: TargetTokenPayload = {
    tokenId: params.tokenId,
    marketId: params.marketId,
    note: params.note,
    savedAt: new Date().toISOString(),
  };

  await prisma.session.update({
    where: { id: params.sessionId },
    data: {
      metadata: {
        ...existingMetadata,
        targetToken: payload,
      },
    },
  });

  return payload;
}
