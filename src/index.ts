import app from "./server";

const port = Number(6060);

// ─── Startup validation ───────────────────────────────────────────────────────
const REQUIRED_ENV = ["TELEGRAM_BOT_TOKEN", "DATABASE_URL", "GEMINI_API_KEY"] as const;
const OPTIONAL_ENV = ["TELEGRAM_WEBHOOK_SECRET", "WAKE_API_TOKEN", "POLY_API_KEY"] as const;

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[startup-error] Required env var "${key}" is not set. The bot may not work correctly.`);
  } else {
    console.log(`[startup-env] ✅ ${key} is set`);
  }
}

for (const key of OPTIONAL_ENV) {
  console.log(`[startup-env] ${process.env[key] ? "✅" : "⚠️ (not set)"} ${key}`);
}

if (process.env.DEBUG === "true") {
  console.log("[startup-env] 🔍 DEBUG mode is ON — full Telegram update payloads will be logged");
}

console.log(`[startup] Server running on http://localhost:${port}`);
// ─────────────────────────────────────────────────────────────────────────────

export default {
  port,
  fetch: app.fetch,
};