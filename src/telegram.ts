import type { Context } from "hono";
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import type { Context as GrammyContext } from "grammy";
import { compileTradingGraph } from "../ai";
import { createNewTask } from "../actions/db";
import { getUserPreferences, updateUserPreferences } from "../actions/userConfig";
import prisma from "../lib/prisma";
import { applyUserPreferences, buildGuardrailsDescription } from "../lib/config";

/**
 * Telegram webhook module (grammY + Hono).
 *
 * ─── QUICK START ──────────────────────────────────────────────────────────────
 *
 * 1. ENVIRONMENT VARIABLES — copy .env.example → .env and fill in every value.
 *    Bun auto-loads .env, so no dotenv import is needed.
 *
 *    Required variables:
 *      TELEGRAM_BOT_TOKEN      — from @BotFather on Telegram
 *      DATABASE_URL            — PostgreSQL connection string (Prisma)
 *      GEMINI_API_KEY          — from https://aistudio.google.com
 *
 *    Optional but recommended:
 *      TELEGRAM_WEBHOOK_SECRET — any random string; add to setWebhook call
 *      WAKE_API_TOKEN          — protects /wake endpoint
 *      POLY_API_KEY / _SECRET / _PASSPHRASE / POLY_PRIVATE_KEY — live trading
 *
 *    Debugging:
 *      DEBUG=true              — logs full Telegram update payloads to console
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
 *    Verify the webhook is registered:
 *      curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
 *
 * 5. SYNC THE SLASH-COMMAND MENU — run once (or after every TELEGRAM_COMMANDS change):
 *      curl -X POST https://<your-domain>/telegram/commands/sync
 *
 * 6. TEST CONNECTIVITY — after starting the server, send /ping to your bot.
 *    The bot should immediately reply with a pong message. If it does not,
 *    check the server logs for [telegram-webhook] and [telegram-message] entries.
 *
 * ─── WHAT IS STILL MISSING ────────────────────────────────────────────────────
 *
 * A. USER AUTHENTICATION / ALLOWLIST
 *    Anyone who finds the bot can call every command.
 *    To restrict access:
 *      1. Add TELEGRAM_ALLOWED_USER_IDS=123456789,987654321 to your .env
 *         (comma-separated Telegram user IDs — find yours via @userinfobot).
 *      2. In dispatchCommand(), add a guard at the top:
 *           const allowedIds = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
 *             .split(",").map(s => s.trim()).filter(Boolean);
 *           if (allowedIds.length > 0 && !allowedIds.includes(String(ctx.from?.id))) {
 *             await replyWithLog(ctx, "⛔ You are not authorised to use this bot.");
 *             return;
 *           }
 *
 * B. /settings COMMAND
 *    Users can toggle dryRun mode and adjust maxOrderSizeUsdc via an
 *    InlineKeyboard.  Preferences are persisted in the UserConfig table and
 *    applied to the live botConfig so they take effect on the next session run
 *    without a process restart.
 *
 * C. SESSION SELECTION FOR /run
 *    /run always targets the most-recent session.  To let the user pick a
 *    session, make /sessions return an InlineKeyboard where each row carries a
 *    callback_data of "run_session:<id>", and add a matching callbackQuery
 *    handler that calls startGraphRun(sessionId, chatId, "Manual").
 *
 * ─── HOW TO PUSH CHANGES ──────────────────────────────────────────────────────
 *
 *    git add src/telegram.ts          # (or `git add -A` for all changes)
 *    git commit -m "feat: improve telegram bot"
 *    git push origin <your-branch>
 *
 *    If you are deploying to a cloud service (Railway, Render, Fly.io, etc.)
 *    the push will trigger a redeploy automatically.  After the new version is
 *    live, re-run the commands/sync endpoint so the slash-command menu updates:
 *      curl -X POST https://<your-domain>/telegram/commands/sync
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** Set DEBUG=true in .env to enable verbose update-payload logging. */
const DEBUG = process.env.DEBUG === "true";

type SessionSnapshot = {
  id: string;
  name: string;
  createdAt: Date;
};

const TELEGRAM_COMMANDS = [
  { command: "ping", description: "Check bot connectivity." },
  { command: "sessions", description: "List recent trade sessions." },
  { command: "current", description: "Show latest session status." },
  { command: "start", description: "Start a new trading session." },
  { command: "run", description: "Run the agent graph on the latest session." },
  { command: "config", description: "Show current trading guardrail config." },
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

/** Emits the full raw Telegram update only when DEBUG=true. */
function logDebugUpdate(ctx: GrammyContext): void {
  if (!DEBUG) return;
  console.log("[telegram-debug-update]", JSON.stringify(ctx.update, null, 2));
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
 * Returns a compact list of recent sessions for /sessions, with stage counts.
 */
async function getSessionsText(): Promise<string> {
  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      name: true,
      createdAt: true,
      _count: { select: { stages: true } },
    },
  });

  if (sessions.length === 0) {
    return "No sessions found. Use /start to create your first session.";
  }

  return [
    `Recent sessions (${sessions.length}):`,
    ...sessions.map(
      (session, index) =>
        `${index + 1}. ${session.name}\n   ID: ${session.id}\n   Stages: ${session._count.stages}  Created: ${session.createdAt.toISOString()}`,
    ),
    "",
    "Use /current to see the latest session in detail.",
    "Use /run to re-run the agent on the latest session.",
  ].join("\n");
}


async function sendCommandDirectory(ctx: GrammyContext): Promise<void> {
  const keyboard = buildCommandKeyboard();
  await replyWithLog(ctx, buildDetailedCommandText(), { reply_markup: keyboard });
}

const SETTINGS_MAX_ORDER_OPTIONS = [25, 50, 100, 200] as const;

/**
 * Builds the settings menu text and InlineKeyboard for a given Telegram user.
 */
async function buildSettingsMenu(
  userId: string,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const prefs = await getUserPreferences(userId);
  const dryRunLabel = prefs.dryRun ? "✅ ON  (no real orders)" : "❌ OFF  (live trading)";

  const text = [
    "⚙️ Bot Settings",
    "",
    `Dry-run mode: ${dryRunLabel}`,
    `Max order size: $${prefs.maxOrderSizeUsdc} USDC`,
    "",
    "Changes take effect immediately for the next session run.",
  ].join("\n");

  const keyboard = new InlineKeyboard()
    .text(
      `Dry run: ${prefs.dryRun ? "✅ ON → turn OFF" : "❌ OFF → turn ON"}`,
      "settings:toggle_dry_run",
    )
    .row()
    .text("Max order size:", "settings:noop");

  for (const amount of SETTINGS_MAX_ORDER_OPTIONS) {
    keyboard.text(
      prefs.maxOrderSizeUsdc === amount ? `✅ $${amount}` : `$${amount}`,
      `settings:max_order:${amount}`,
    );
  }

  return { text, keyboard };
}

/**
 * Sends or re-renders the settings menu for the calling user.
 */
async function sendSettingsMenu(ctx: GrammyContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await replyWithLog(ctx, "Cannot read your Telegram user ID.");
    return;
  }

  const { text, keyboard } = await buildSettingsMenu(String(userId));
  await replyWithLog(ctx, text, { reply_markup: keyboard });
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
    case "ping": {
      const messageDate = ctx.message?.date;
      const latencyMs = messageDate ? Date.now() - messageDate * 1000 : null;
      await replyWithLog(
        ctx,
        [
          "🏓 Pong!",
          `Bot is online and reachable.`,
          `Server time: ${new Date().toISOString()}`,
          latencyMs !== null ? `Approx. latency: ${latencyMs}ms` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }
    case "start": {
      if (ctx.from?.id) {
        // Apply this user's stored preferences to the shared botConfig before
        // starting the session.  This bot is designed for a single operator, so
        // concurrent multi-user calls are not expected; preferences in the DB
        // remain authoritative across restarts.
        const prefs = await getUserPreferences(String(ctx.from.id));
        applyUserPreferences(prefs);
      }
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
      if (ctx.from?.id) {
        // Same single-operator assumption as in "start" above.
        const prefs = await getUserPreferences(String(ctx.from.id));
        applyUserPreferences(prefs);
      }
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
      await sendSettingsMenu(ctx);
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
        username: message.from?.username ?? null,
        text: body,
      }),
    );

    logDebugUpdate(ctx);
    await next();
  });

  bot.command("ping", async (ctx) => dispatchCommand(ctx, "ping"));
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

    console.log(
      "[telegram-callback]",
      JSON.stringify({
        updateId: ctx.update.update_id,
        chatId: ctx.chat?.id ?? null,
        userId: ctx.from?.id ?? null,
        data: ctx.callbackQuery.data,
        resolvedCommand: command ?? null,
      }),
    );

    if (DEBUG) {
      console.log("[telegram-debug-update]", JSON.stringify(ctx.update, null, 2));
    }

    if (!command || !SUPPORTED_COMMANDS.has(command)) {
      await ctx.answerCallbackQuery({ text: "Unknown command selection." });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Running /${command}` });
    await dispatchCommand(ctx, command as TelegramCommandName);
  });

  bot.callbackQuery("settings:noop", async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("settings:toggle_dry_run", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.answerCallbackQuery({ text: "Cannot read your user ID." });
      return;
    }

    const current = await getUserPreferences(String(userId));
    const updated = await updateUserPreferences(String(userId), { dryRun: !current.dryRun });
    applyUserPreferences(updated);

    const { text, keyboard } = await buildSettingsMenu(String(userId));
    await ctx.answerCallbackQuery({
      text: `Dry run is now ${updated.dryRun ? "ON" : "OFF"}.`,
    });
    await ctx.editMessageText(text, { reply_markup: keyboard });
  });

  bot.callbackQuery(/^settings:max_order:(\d+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.answerCallbackQuery({ text: "Cannot read your user ID." });
      return;
    }

    const amountStr = Array.isArray(ctx.match) ? ctx.match[1] : null;
    const amount = amountStr ? Number(amountStr) : NaN;
    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.answerCallbackQuery({ text: "Invalid amount." });
      return;
    }

    const updated = await updateUserPreferences(String(userId), { maxOrderSizeUsdc: amount });
    applyUserPreferences(updated);

    const { text, keyboard } = await buildSettingsMenu(String(userId));
    await ctx.answerCallbackQuery({ text: `Max order size set to $${amount} USDC.` });
    await ctx.editMessageText(text, { reply_markup: keyboard });
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
  const secretConfigured = Boolean(process.env.TELEGRAM_WEBHOOK_SECRET);
  const secretValid = verifyTelegramSecret(c);

  console.log(
    "[telegram-webhook]",
    JSON.stringify({
      method: c.req.method,
      path: c.req.path,
      secretConfigured,
      secretValid,
      receivedAt: new Date().toISOString(),
    }),
  );

  if (secretConfigured && !secretValid) {
    console.warn("[telegram-webhook-unauthorized]", JSON.stringify({ receivedAt: new Date().toISOString() }));
    return c.json({ error: "Unauthorized." }, 401);
  }

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
