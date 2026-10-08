import { log } from "./logger.js";

export class TelegramError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "TelegramError";
  }
}

/** "sent" = delivered to Telegram; "dryrun" = only logged (nothing left the machine). */
export type SendResult = "sent" | "dryrun";

export interface TelegramSender {
  send(text: string): Promise<SendResult | void>;
}

/** Real Telegram sender (HTML parse mode). */
export class TelegramClient implements TelegramSender {
  constructor(private readonly botToken: string, private readonly chatId: string) {}

  async send(text: string): Promise<SendResult> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429 || res.status >= 500) {
      let retryAfterMs: number | undefined;
      try {
        const body = (await res.json()) as any;
        if (body?.parameters?.retry_after) retryAfterMs = body.parameters.retry_after * 1000;
      } catch {
        /* ignore */
      }
      throw new TelegramError(`Telegram HTTP ${res.status}`, res.status, retryAfterMs);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new TelegramError(`Telegram HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);
    }
    return "sent";
  }
}

/** Dry-run sender: logs instead of sending. */
export class DryRunSender implements TelegramSender {
  async send(text: string): Promise<SendResult> {
    log.info("[DRY_RUN] would send Telegram message:\n" + text);
    return "dryrun";
  }
}

/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(s: string): string {
  // \u0001 delimits internal age markers (see age.ts); never let token-controlled
  // text carry one.
  return s.replace(/\u0001/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TELEGRAM_MAX = 4096;
export function clampMessage(s: string): string {
  if (s.length <= TELEGRAM_MAX) return s;
  return s.slice(0, TELEGRAM_MAX - 20) + "\n… (truncated)";
}
