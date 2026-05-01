import prisma from "./prisma";
import type { Prisma } from "../src/generated/prisma/client";

type SessionMetadata = Record<string, unknown>;
type StageLock = {
  traceId: string;
  expiresAt: string;
};

async function getSessionMetadata(sessionId: string): Promise<SessionMetadata> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { metadata: true },
  });

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (!session.metadata || typeof session.metadata !== "object") {
    throw new Error(`Session ${sessionId} has no metadata.`);
  }

  return session.metadata as SessionMetadata;
}

function getStageLockFromMetadata(metadata: SessionMetadata): StageLock | null {
  const lock = metadata.stageLock;
  if (!lock || typeof lock !== "object") {
    return null;
  }

  const value = lock as Record<string, unknown>;
  if (typeof value.traceId !== "string" || typeof value.expiresAt !== "string") {
    return null;
  }

  return { traceId: value.traceId, expiresAt: value.expiresAt };
}

/**
 * Builds a formatted chronological stage history string for one session.
 */
export async function buildSessionStageHistory(sessionId: string): Promise<string> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      name: true,
      stages: {
        select: {
          sequence: true,
          summary: true,
          sessionAction: true,
          stageActionCompleted: true,
          todo: true,
        },
        orderBy: { sequence: "asc" },
      },
    },
  });

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (session.stages.length === 0) {
    return `Session: ${session.name} (${session.id})\nNo stage history yet.`;
  }

  const chunks = session.stages.map((stage) =>
    [
      `Occurrence ${stage.sequence}`,
      `Action: ${stage.sessionAction}`,
      `Completed: ${stage.stageActionCompleted}`,
      `Summary: ${stage.summary}`,
      `Next TODO: ${stage.todo}`,
    ].join("\n"),
  );

  return [`Session: ${session.name} (${session.id})`, chunks.join("\n\n---\n\n")].join("\n\n");
}

export async function getTargetToken(sessionId: string): Promise<string> {
  const metadata = await getSessionMetadata(sessionId);
  const targetToken = metadata.targetToken;

  if (!targetToken || typeof targetToken !== "object") {
    throw new Error(`Session ${sessionId} has no targetToken saved.`);
  }

  const tokenId = (targetToken as Record<string, unknown>).tokenId;
  if (typeof tokenId !== "string" || tokenId.length === 0) {
    throw new Error(`Session ${sessionId} has an invalid targetToken.tokenId.`);
  }

  return tokenId;
}

export async function getSessionOrderId(sessionId: string): Promise<string> {
  const metadata = await getSessionMetadata(sessionId);
  const orderId = metadata.activeOrderId;

  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new Error(`Session ${sessionId} has no activeOrderId saved.`);
  }

  return orderId;
}

export async function setSessionOrderId(sessionId: string, orderId: string): Promise<void> {
  if (!orderId) {
    throw new Error("orderId is required.");
  }

  const metadata = await getSessionMetadata(sessionId);
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      metadata: {
        ...metadata,
        activeOrderId: orderId,
      } as Prisma.InputJsonValue,
    },
  });
}

export async function clearSessionOrderId(sessionId: string): Promise<void> {
  const metadata = await getSessionMetadata(sessionId);
  const { activeOrderId: _activeOrderId, ...rest } = metadata;

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      metadata: rest as Prisma.InputJsonValue,
    },
  });
}

/**
 * Acquires a per-session stage execution lock for one wake trace.
 * Re-entrant for the same traceId while lock is valid.
 */
export async function acquireStageLock(
  sessionId: string,
  traceId: string,
  ttlMs = 30_000,
): Promise<void> {
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessionId}::uuid FOR UPDATE`;
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      select: { metadata: true },
    });

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const metadata =
      session.metadata && typeof session.metadata === "object"
        ? (session.metadata as SessionMetadata)
        : {};

    const currentLock = getStageLockFromMetadata(metadata);
    if (currentLock) {
      const lockExpires = new Date(currentLock.expiresAt).getTime();
      const lockActive = Number.isFinite(lockExpires) && lockExpires > now;
      const lockOwnedByOtherTrace = currentLock.traceId !== traceId;
      if (lockActive && lockOwnedByOtherTrace) {
        throw new Error(
          `Session ${sessionId} is locked by trace ${currentLock.traceId} until ${currentLock.expiresAt}.`,
        );
      }
    }

    await tx.session.update({
      where: { id: sessionId },
      data: {
        metadata: {
          ...metadata,
          stageLock: {
            traceId,
            expiresAt,
          },
        } as Prisma.InputJsonValue,
      },
    });
  });
}

export async function releaseStageLock(sessionId: string, traceId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessionId}::uuid FOR UPDATE`;
    const session = await tx.session.findUnique({
      where: { id: sessionId },
      select: { metadata: true },
    });

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (!session.metadata || typeof session.metadata !== "object") {
      return;
    }

    const metadata = session.metadata as SessionMetadata;
    const currentLock = getStageLockFromMetadata(metadata);
    if (!currentLock || currentLock.traceId !== traceId) {
      return;
    }

    const { stageLock: _stageLock, ...rest } = metadata;
    await tx.session.update({
      where: { id: sessionId },
      data: {
        metadata: rest as Prisma.InputJsonValue,
      },
    });
  });
}
