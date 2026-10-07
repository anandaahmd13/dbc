import "dotenv/config";

export interface Config {
  heliusRpcUrl: string;
  heliusWsUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  dryRun: boolean;
  maxCreatorLaunches: number;
  watchWindowMs: number;
  databasePath: string;
  ordersRpm: number;
  tokensRpm: number;
  /** Max txs the startup backfill may inspect; 0 disables it (default). */
  backfillMaxTx: number;
  /** Send a Telegram message for every new eligible launch (default off). */
  alertOnLaunch: boolean;
}

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

function optStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} is not a number: ${v}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

/**
 * Load config. `requireSecrets=false` lets read-only tools (inspect script,
 * dry runs) start without Telegram credentials.
 */
export function loadConfig(requireSecrets = true): Config {
  const dryRun = bool("DRY_RUN", true);
  const needTelegram = requireSecrets && !dryRun;

  return {
    heliusRpcUrl: str("HELIUS_RPC_URL"),
    heliusWsUrl: optStr("HELIUS_WS_URL", deriveWs(process.env.HELIUS_RPC_URL)),
    telegramBotToken: needTelegram ? str("TELEGRAM_BOT_TOKEN") : optStr("TELEGRAM_BOT_TOKEN", ""),
    telegramChatId: needTelegram ? str("TELEGRAM_CHAT_ID") : optStr("TELEGRAM_CHAT_ID", ""),
    dryRun,
    maxCreatorLaunches: num("MAX_CREATOR_LAUNCHES", 10),
    watchWindowMs: num("WATCH_WINDOW_MINUTES", 1440) * 60_000,
    databasePath: optStr("DATABASE_PATH", "./data/tracker.db"),
    ordersRpm: num("ORDERS_RPM", 50),
    tokensRpm: num("TOKENS_RPM", 240),
    backfillMaxTx: num("BACKFILL_MAX_TX", 0),
    alertOnLaunch: bool("ALERT_ON_LAUNCH", false),
  };
}

function deriveWs(httpUrl: string | undefined): string {
  if (!httpUrl) return "";
  return httpUrl.replace(/^http/i, "ws");
}
