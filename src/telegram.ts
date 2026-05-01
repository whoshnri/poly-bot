import type { Context } from "hono";
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import type { Context as GrammyContext } from "grammy";
import { compileTradingGraph } from "../ai";
import { createNewTask } from "../actions/db";
import prisma from "../lib/prisma";
import { buildGuardrailsDescription } from "../lib/config";

/**
 * Telegram webhook module (grammY + Hono).
 *
 * Usage:
 * 1) Set TELEGRAM_BOT_TOKEN (required).
 * 2) Optionally set TELEGRAM_WEBHOOK_SECRET, then pass the same secret to Telegram setWebhook.
 * 3) Expose POST /telegram/webhook publicly and register that URL with Telegram.
 * 4) Call POST /telegram/commands/sync once to publish the slash-command menu.
 */
type SessionSnapshot = {
  id: string;
  name: string;
  createdAt: Date;
};

type SessionResumeTarget = {
  id: string;
  name: string;
  createdAt: Date;
  latestStage: {
    sequence: number;
    sessionAction: string;
    stageActionCompleted: boolean;
    summary: string;
  } | null;
};

const TELEGRAM_COMMANDS = [
  { command: "config", description: "Set your trading preferences." },
  { command: "sessions", description: "List recent trade sessions." },
  { command: "current", description: "Show latest session status." },
  { command: "start", description: "Start a new trading session." },
  { command: "exit", description: "Exit current interaction." },
  { command: "settings", description: "Adjust your experience." },
  { command: "help", description: "Show all commands and quick actions." },
] as const;

const SUPPORTED_COMMANDS = new Set<string>(TELEGRAM_COMMANDS.map((command) => command.command));
type TelegramCommandName = (typeof TELEGRAM_COMMANDS)[number]["command"];
let botInstance: Bot | null = null;

/**
 * Reads the bot token once commands need Telegram API access.
 */
function getTelegramToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for Telegram webhook handling.");
  }
  return token;
}

function verifyTelegramSecret(c: Context): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    return true;
  }

  const provided = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  return provided === expected;
}

function commandHelpText(): string {
  return [
    "Available commands:",
    ...TELEGRAM_COMMANDS.map((entry) => `/${entry.command} - ${entry.description}`),
  ].join("\n");
}

function buildCommandKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  TELEGRAM_COMMANDS.forEach((entry, index) => {
    keyboard.text(`/${entry.command}`, `run_command:${entry.command}`);
    if (index % 2 === 1) {
      keyboard.row();
    }
  });
  return keyboard;
}

function buildDetailedCommandText(): string {
  return [
    "Control center: choose what you want to do next.",
    "You can tap any button below, or type a slash command directly.",
    "",
    ...TELEGRAM_COMMANDS.map((entry, index) => `${index + 1}) /${entry.command} - ${entry.description}`),
  ].join("\n");
}

type ReplyOptions = Parameters<GrammyContext["reply"]>[1];

async function replyWithLog(ctx: GrammyContext, text: string, options?: ReplyOptions): Promise<void> {
  console.log(
    "[telegram-response]",
    JSON.stringify({
      updateId: ctx.update.update_id,
      chatId: ctx.chat?.id ?? null,
      userId: ctx.from?.id ?? null,
      text,
      hasInlineKeyboard: Boolean(options?.reply_markup),
    }),
  );
  await ctx.reply(text, options);
}

/**
 * Starts the autonomous graph in the background for a newly created session.
 */
function startInitialGraphRun(sessionId: string): void {
  const { invoke } = compileTradingGraph({ sessionId, forceInitPath: true });
  invoke()
    .then(() => {
      console.log(`[session-start] Initial graph run completed for session=${sessionId}`);
    })
    .catch((err: unknown) => {
      console.error(
        `[session-start] Initial graph run failed for session=${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    });
}

/**
 * Creates one persisted session and immediately kicks off its first AI run.
 */
async function createSession(): Promise<SessionSnapshot> {
  const session = await createNewTask({
    name: `Autonomous session ${new Date().toISOString()}`,
    metadata: { targetToken: null },
  });

  startInitialGraphRun(session.id);
  return { id: session.id, name: session.name, createdAt: session.createdAt };
}

/**
 * Returns a text snapshot of the most recent session + latest stage state.
 */
async function getLatestSessionText(): Promise<string> {
  const session = await prisma.session.findFirst({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      stages: {
        orderBy: { sequence: "desc" },
        take: 1,
        select: {
          sequence: true,
          summary: true,
          sessionAction: true,
          stageActionCompleted: true,
        },
      },
    },
  });

  if (!session) {
    return "No sessions found.";
  }

  const latestStage = session.stages[0];
  if (!latestStage) {
    return [
      "Current session",
      `ID: ${session.id}`,
      `Name: ${session.name}`,
      `Created: ${session.createdAt.toISOString()}`,
      "No stages yet.",
    ].join("\n");
  }

  return [
    "Current session",
    `ID: ${session.id}`,
    `Name: ${session.name}`,
    `Created: ${session.createdAt.toISOString()}`,
    `Latest stage: #${latestStage.sequence} (${latestStage.sessionAction})`,
    `Stage completed: ${latestStage.stageActionCompleted ? "yes" : "no"}`,
    `Summary: ${latestStage.summary}`,
  ].join("\n");
}

/**
 * Returns a compact list of recent sessions for /sessions.
 */
async function getSessionsText(): Promise<string> {
  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      name: true,
      createdAt: true,
    },
  });

  if (sessions.length === 0) {
    return "No sessions found.";
  }

  return [
    "Recent sessions:",
    ...sessions.map(
      (session, index) =>
        `${index + 1}. ${session.id} - ${session.name} (${session.createdAt.toISOString()})`,
    ),
  ].join("\n");
}

async function getSessionResumeTargets(): Promise<SessionResumeTarget[]> {
  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      name: true,
      createdAt: true,
      stages: {
        orderBy: { sequence: "desc" },
        take: 1,
        select: {
          sequence: true,
          summary: true,
          sessionAction: true,
          stageActionCompleted: true,
        },
      },
    },
  });

  return sessions.map((session) => ({
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    latestStage: session.stages[0] ?? null,
  }));
}

function buildSessionResumeKeyboard(sessions: SessionResumeTarget[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  sessions.forEach((session, index) => {
    keyboard.text(`Resume #${index + 1}`, `resume_session:${session.id}`).row();
  });

  return keyboard;
}

function buildSessionSelectionText(sessions: SessionResumeTarget[]): string {
  const lines = [
    "Choose a session to resume.",
    "Tap a button below to resume that exact session context.",
    "Note: resume is currently mocked and does not trigger live trading yet.",
    "",
    "Recent sessions:",
  ];

  for (const [index, session] of sessions.entries()) {
    lines.push(`${index + 1}) ${session.name}`);
    lines.push(`- ID: ${session.id}`);
    lines.push(`- Created: ${session.createdAt.toISOString()}`);

    if (!session.latestStage) {
      lines.push("- Latest stage: none");
      continue;
    }

    lines.push(
      `- Latest stage: #${session.latestStage.sequence} (${session.latestStage.sessionAction})`,
    );
    lines.push(`- Stage completed: ${session.latestStage.stageActionCompleted ? "yes" : "no"}`);
    lines.push(`- Summary: ${session.latestStage.summary}`);
  }

  return lines.join("\n");
}

/**
 * Mocked resume path for inline session selection.
 * Real resume execution will be implemented later.
 */
async function mockResumeSession(sessionId: string, requestedByUserId: number | null): Promise<string> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      name: true,
      createdAt: true,
      stages: {
        orderBy: { sequence: "desc" },
        take: 1,
        select: {
          sequence: true,
          sessionAction: true,
          stageActionCompleted: true,
        },
      },
    },
  });

  if (!session) {
    return `Could not resume session ${sessionId}: session not found.`;
  }

  const latestStage = session.stages[0];

  console.log(
    "[telegram-resume-mock]",
    JSON.stringify({
      sessionId: session.id,
      requestedByUserId,
      requestedAt: new Date().toISOString(),
    }),
  );

  return [
    "Resume request received.",
    "This is a mocked resume flow for now (no live execution yet).",
    `Session ID: ${session.id}`,
    `Session Name: ${session.name}`,
    `Created: ${session.createdAt.toISOString()}`,
    latestStage
      ? `Latest stage: #${latestStage.sequence} (${latestStage.sessionAction}), completed=${latestStage.stageActionCompleted ? "yes" : "no"}`
      : "Latest stage: none",
    "Implementation note: replace mockResumeSession(...) with real resume logic later.",
  ].join("\n");
}

async function sendSessionsSelection(ctx: GrammyContext): Promise<void> {
  const sessions = await getSessionResumeTargets();
  if (sessions.length === 0) {
    await replyWithLog(
      ctx,
      "No saved sessions were found yet.\nUse /start to create your first session.",
    );
    return;
  }

  const keyboard = buildSessionResumeKeyboard(sessions);
  const detailedText = buildSessionSelectionText(sessions);
  await replyWithLog(ctx, detailedText, { reply_markup: keyboard });
}

async function sendCommandDirectory(ctx: GrammyContext): Promise<void> {
  const keyboard = buildCommandKeyboard();
  await replyWithLog(ctx, buildDetailedCommandText(), { reply_markup: keyboard });
}

async function dispatchCommand(ctx: GrammyContext, command: TelegramCommandName): Promise<void> {
  switch (command) {
    case "start": {
      const session = await createSession();
      await replyWithLog(
        ctx,
        [
          "Started a new trading session.",
          `Session ID: ${session.id}`,
          `Name: ${session.name}`,
        ].join("\n"),
      );
      return;
    }
    case "current":
      await replyWithLog(ctx, await getLatestSessionText());
      return;
    case "sessions":
      await sendSessionsSelection(ctx);
      return;
    case "config":
      await replyWithLog(ctx, `Current config:\n${buildGuardrailsDescription()}`);
      return;
    case "settings":
      await replyWithLog(ctx, "Settings command received. Settings flow is not implemented yet.");
      return;
    case "exit":
      await replyWithLog(ctx, "Exited current interaction. Use /start when you are ready to continue.");
      return;
    case "help":
      await sendCommandDirectory(ctx);
      return;
  }
}

/**
 * Lazy singleton bot setup.
 * Commands are registered once and reused for every webhook request.
 */
function getBot(): Bot {
  if (botInstance) {
    return botInstance;
  }

  const bot = new Bot(getTelegramToken());

  // Prevent full ctx dumps on unhandled errors; log only debug-relevant fields.
  bot.catch((err) => {
    const ctx = err.ctx;
    const messageText = ctx.message && "text" in ctx.message ? ctx.message.text : null;
    console.error(
      "[telegram-error]",
      JSON.stringify({
        updateId: ctx.update.update_id,
        chatId: ctx.chat?.id ?? null,
        userId: ctx.from?.id ?? null,
        message: err.error instanceof Error ? err.error.message : String(err.error),
        text: messageText,
      }),
    );
  });

  // Logs every inbound Telegram message so webhook traffic is visible in server logs.
  bot.on("message", async (ctx, next) => {
    const message = ctx.message;
    const body =
      "text" in message
        ? message.text
        : "caption" in message && typeof message.caption === "string"
          ? message.caption
          : "[non-text message]";

    console.log(
      "[telegram-message]",
      JSON.stringify({
        updateId: ctx.update.update_id,
        messageId: message.message_id,
        chatId: message.chat.id,
        userId: message.from?.id ?? null,
        text: body,
      }),
    );

    await next();
  });

  bot.command("start", async (ctx) => dispatchCommand(ctx, "start"));
  bot.command("current", async (ctx) => dispatchCommand(ctx, "current"));
  bot.command("sessions", async (ctx) => dispatchCommand(ctx, "sessions"));
  bot.command("config", async (ctx) => dispatchCommand(ctx, "config"));
  bot.command("settings", async (ctx) => dispatchCommand(ctx, "settings"));
  bot.command("exit", async (ctx) => dispatchCommand(ctx, "exit"));
  bot.command("help", async (ctx) => dispatchCommand(ctx, "help"));

  bot.callbackQuery(/^resume_session:(.+)$/, async (ctx) => {
    const sessionId = Array.isArray(ctx.match) ? ctx.match[1] : null;
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: "Invalid session selection." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Resume request received." });
    const response = await mockResumeSession(sessionId, ctx.from?.id ?? null);
    await replyWithLog(ctx, response);
  });

  bot.callbackQuery(/^run_command:(.+)$/, async (ctx) => {
    const command = Array.isArray(ctx.match) ? ctx.match[1] : null;
    if (!command || !SUPPORTED_COMMANDS.has(command)) {
      await ctx.answerCallbackQuery({ text: "Unknown command selection." });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Running /${command}` });
    await dispatchCommand(ctx, command as TelegramCommandName);
  });

  // If user sends an unknown slash command, show available command help.
  bot.on("message:text", async (ctx, next) => {
    const rawText = ctx.message.text.trim();
    if (!rawText.startsWith("/")) {
      return next();
    }

    const firstToken = rawText.split(/\s+/)[0];
    if (!firstToken) {
      return next();
    }

    const normalized = firstToken.slice(1).split("@")[0]?.toLowerCase();
    if (normalized && SUPPORTED_COMMANDS.has(normalized)) {
      return next();
    }

    await sendCommandDirectory(ctx);
  });

  botInstance = bot;
  return bot;
}

export async function handleTelegramWebhook(c: Context) {
  // if (!verifyTelegramSecret(c)) {
  //   return c.json({ error: "Unauthorized." }, 401);
  // }

  console.log("context recieved")
  const callback = webhookCallback(getBot(), "std/http");
  return callback(c.req.raw);
}

/**
 * Publishes TELEGRAM_COMMANDS to Telegram's command menu.
 * Trigger this endpoint after command changes so clients show the latest list.
 */
export async function syncTelegramCommands(c: Context) {
  const bot = getBot();
  await bot.api.setMyCommands(TELEGRAM_COMMANDS.map((entry) => ({ ...entry })));
  return c.json({ synced: true, commands: TELEGRAM_COMMANDS });
}
