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
 * ─── QUICK START ──────────────────────────────────────────────────────────────
 *
 * 1. ENVIRONMENT VARIABLES — copy .env.example → .env and fill in every value.
 *    Bun auto-loads .env, so no dotenv import is needed.
 *
 * 2. DATABASE MIGRATIONS — run once before first use:
 *      bunx prisma migrate deploy        # production
 *      bunx prisma migrate dev           # development (also regenerates client)
 *
 * 3. START THE SERVER:
 *      bun run dev                       # watch mode
 *      bun run start                     # production
 *
 * 4. REGISTER THE TELEGRAM WEBHOOK — run once after deployment:
 *      curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *           -H "Content-Type: application/json" \
 *           -d '{"url":"https://<your-domain>/telegram/webhook",
 *                "secret_token":"<TELEGRAM_WEBHOOK_SECRET>"}'
 *
 * 5. SYNC THE SLASH-COMMAND MENU — run once (or after every TELEGRAM_COMMANDS change):
 *      curl -X POST https://<your-domain>/telegram/commands/sync
 *
 * ─── WHAT IS STILL MISSING ────────────────────────────────────────────────────
 *
 * A. USER AUTHENTICATION / ALLOWLIST
 *    Anyone who finds the bot can call every command.
 *    Add an allowlist check in dispatchCommand() using ctx.from?.id compared
 *    against a TELEGRAM_ALLOWED_USER_IDS env var (comma-separated user IDs).
 *
 * B. /settings COMMAND
 *    Currently a stub.  Wire it up to a Prisma-backed user-preferences table
 *    (or use session metadata JSON) to let users toggle dryRun, maxOrderSize, etc.
 * ──────────────────────────────────────────────────────────────────────────────
 */
type SessionSnapshot = {
  id: string;
  name: string;
  createdAt: Date;
};

const TELEGRAM_COMMANDS = [
  { command: "config", description: "Set your trading preferences." },
  { command: "sessions", description: "List recent trade sessions." },
  { command: "current", description: "Show latest session status." },
  { command: "start", description: "Start a new trading session." },
  { command: "run", description: "Run the agent graph on the latest session." },
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
 * Starts the autonomous graph in the background.
 * When chatId is provided, sends a Telegram message on completion or failure.
 */
function startGraphRun(sessionId: string, chatId?: number, label = "Initial"): void {
  console.log(
    "[graph-run-start]",
    JSON.stringify({ sessionId, chatId: chatId ?? null, label, startedAt: new Date().toISOString() }),
  );

  const { invoke } = compileTradingGraph({ sessionId, forceInitPath: true });

  invoke()
    .then(() => {
      console.log(
        "[graph-run-done]",
        JSON.stringify({ sessionId, label, completedAt: new Date().toISOString() }),
      );
      if (chatId) {
        getBot()
          .api.sendMessage(
            chatId,
            [
              `✅ Agent graph run finished.`,
              `Session: ${sessionId}`,
              `Use /current to see the latest stage.`,
            ].join("\n"),
          )
          .catch((err: unknown) => {
            console.error(
              "[graph-run-notify-error]",
              JSON.stringify({
                sessionId,
                chatId,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          });
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        "[graph-run-error]",
        JSON.stringify({ sessionId, label, error: message, failedAt: new Date().toISOString() }),
      );
      if (chatId) {
        getBot()
          .api.sendMessage(
            chatId,
            [
              `❌ Agent graph run failed.`,
              `Session: ${sessionId}`,
              `Error: ${message}`,
            ].join("\n"),
          )
          .catch((notifyErr: unknown) => {
            console.error(
              "[graph-run-notify-error]",
              JSON.stringify({
                sessionId,
                chatId,
                error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
              }),
            );
          });
      }
    });
}

/**
 * Creates one persisted session and immediately kicks off its first AI run.
 * chatId is optional; when supplied the user receives a Telegram message on completion.
 */
async function createSession(chatId?: number): Promise<SessionSnapshot> {
  console.log("[session-create]", JSON.stringify({ chatId: chatId ?? null, at: new Date().toISOString() }));

  const session = await createNewTask({
    name: `Autonomous session ${new Date().toISOString()}`,
    metadata: { targetToken: null },
  });

  console.log("[session-created]", JSON.stringify({ sessionId: session.id, name: session.name }));

  startGraphRun(session.id, chatId, "Initial");
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


async function sendCommandDirectory(ctx: GrammyContext): Promise<void> {
  const keyboard = buildCommandKeyboard();
  await replyWithLog(ctx, buildDetailedCommandText(), { reply_markup: keyboard });
}

async function dispatchCommand(ctx: GrammyContext, command: TelegramCommandName): Promise<void> {
  const chatId = ctx.chat?.id ?? undefined;

  console.log(
    "[telegram-command]",
    JSON.stringify({
      command,
      updateId: ctx.update.update_id,
      chatId: chatId ?? null,
      userId: ctx.from?.id ?? null,
      username: ctx.from?.username ?? null,
    }),
  );

  switch (command) {
    case "start": {
      const session = await createSession(chatId);
      await replyWithLog(
        ctx,
        [
          "🚀 Started a new trading session.",
          `Session ID: ${session.id}`,
          `Name: ${session.name}`,
          "",
          "The agent graph is now running in the background.",
          "You will receive a message here when it completes.",
          "Use /current to check the latest stage at any time.",
        ].join("\n"),
      );
      return;
    }
    case "run": {
      const latestSession = await prisma.session.findFirst({
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true },
      });

      if (!latestSession) {
        await replyWithLog(
          ctx,
          "No sessions found. Use /start to create your first session.",
        );
        return;
      }

      console.log(
        "[telegram-run]",
        JSON.stringify({
          sessionId: latestSession.id,
          chatId: chatId ?? null,
          triggeredAt: new Date().toISOString(),
        }),
      );

      startGraphRun(latestSession.id, chatId, "Manual");
      await replyWithLog(
        ctx,
        [
          "▶️ Agent graph run triggered.",
          `Session ID: ${latestSession.id}`,
          `Session Name: ${latestSession.name}`,
          "",
          "The agent is running in the background.",
          "You will receive a message here when it completes.",
          "Use /current to check progress.",
        ].join("\n"),
      );
      return;
    }
    case "current":
      await replyWithLog(ctx, await getLatestSessionText());
      return;
    case "sessions":
      await replyWithLog(ctx, await getSessionsText());
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

  console.log("[telegram-bot-init]", JSON.stringify({ initializedAt: new Date().toISOString() }));

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
  bot.command("run", async (ctx) => dispatchCommand(ctx, "run"));
  bot.command("current", async (ctx) => dispatchCommand(ctx, "current"));
  bot.command("sessions", async (ctx) => dispatchCommand(ctx, "sessions"));
  bot.command("config", async (ctx) => dispatchCommand(ctx, "config"));
  bot.command("settings", async (ctx) => dispatchCommand(ctx, "settings"));
  bot.command("exit", async (ctx) => dispatchCommand(ctx, "exit"));
  bot.command("help", async (ctx) => dispatchCommand(ctx, "help"));

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

  console.log(
    "[telegram-webhook]",
    JSON.stringify({
      method: c.req.method,
      path: c.req.path,
      hasSecret: Boolean(c.req.header("X-Telegram-Bot-Api-Secret-Token")),
      receivedAt: new Date().toISOString(),
    }),
  );
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
