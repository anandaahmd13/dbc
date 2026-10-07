import { Connection, PublicKey } from "@solana/web3.js";
import { DbcClient, DBC_PROGRAM_ID, decodeInitializePoolEvents } from "./dbc.js";
import { log } from "../logger.js";

export interface DetectedLaunch {
  pool: string;
  baseMint: string;
  creator: string;
  signature: string;
}

const CURSOR_NAME = "launch_last_signature";
const MAX_BACKFILL = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CursorStore {
  getCursor(name: string): string | null;
  setCursor(name: string, value: string | null): void;
}

/**
 * Watches the DBC program for new pool launches.
 *
 * - Subscribes to program logs over WebSocket (Helius).
 * - On start / reconnect, backfills missed signatures since the stored cursor.
 * - Cold start (no cursor) records the newest signature as the cursor WITHOUT
 *   replaying history, so the bot doesn't alert on old launches.
 */
export class LaunchWatcher {
  private subId: number | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private readonly seen = new Set<string>();

  constructor(
    private readonly connection: Connection,
    private readonly dbc: DbcClient,
    private readonly cursor: CursorStore,
    private readonly onLaunch: (l: DetectedLaunch) => Promise<void>
  ) {}

  async start(): Promise<void> {
    await this.coldStartIfNeeded();
    await this.backfill();
    this.subscribe();
  }

  stop(): void {
    this.stopped = true;
    if (this.subId !== null) {
      this.connection.removeOnLogsListener(this.subId).catch(() => {});
      this.subId = null;
    }
  }

  private async coldStartIfNeeded(): Promise<void> {
    if (this.cursor.getCursor(CURSOR_NAME)) return;
    try {
      const sigs = await this.connection.getSignaturesForAddress(DBC_PROGRAM_ID, { limit: 1 });
      const newest = sigs[0]?.signature ?? null;
      this.cursor.setCursor(CURSOR_NAME, newest);
      log.info(`cold start: cursor set to ${newest ?? "(none)"}; not replaying history`);
    } catch (err) {
      log.warn("cold start cursor init failed; will treat first live event as baseline", msg(err));
    }
  }

  /** Replay signatures newer than the cursor (oldest-first) after a gap. */
  private async backfill(): Promise<void> {
    const until = this.cursor.getCursor(CURSOR_NAME) ?? undefined;
    if (!until) return;
    let sigs;
    try {
      sigs = await this.connection.getSignaturesForAddress(DBC_PROGRAM_ID, { until });
    } catch (err) {
      log.warn("backfill getSignaturesForAddress failed", msg(err));
      return;
    }
    if (sigs.length === 0) return;

    // Cap replay: a large gap (long downtime / very active program) would mean
    // thousands of getTransaction calls and hammer the RPC. Live subscription
    // covers new launches anyway, so only replay a bounded recent slice and
    // fast-forward the cursor past the rest.
    if (sigs.length > MAX_BACKFILL) {
      const newest = sigs[0]?.signature ?? null;
      log.warn(
        `backfill gap of ${sigs.length} > ${MAX_BACKFILL}; skipping replay and fast-forwarding cursor`
      );
      this.cursor.setCursor(CURSOR_NAME, newest);
      return;
    }

    log.info(`backfilling ${sigs.length} signature(s) since cursor`);
    // API returns newest-first; process oldest-first so the cursor advances safely.
    for (const s of sigs.reverse()) {
      if (s.err) continue;
      await this.processSignature(s.signature);
      await sleep(120); // gentle throttle to stay under RPC limits
    }
  }

  private subscribe(): void {
    if (this.stopped) return;
    try {
      this.subId = this.connection.onLogs(
        DBC_PROGRAM_ID,
        (logInfo, ctx) => {
          if (logInfo.err) return;
          void this.handleLogs(logInfo.signature, logInfo.logs);
          void ctx;
        },
        "confirmed"
      );
      this.backoffMs = 1000;
      log.info("subscribed to DBC program logs");
    } catch (err) {
      this.scheduleReconnect(msg(err));
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    log.warn(`log subscription lost (${reason}); reconnecting in ${delay}ms`);
    setTimeout(() => {
      void (async () => {
        await this.backfill();
        this.subscribe();
      })();
    }, delay);
  }

  /** Decode launch events directly from live log messages. */
  private async handleLogs(signature: string, logs: string[]): Promise<void> {
    try {
      const events = decodeInitializePoolEvents(this.dbc.program as any, logs);
      for (const ev of events) {
        await this.emit({ ...ev, signature });
      }
      this.cursor.setCursor(CURSOR_NAME, signature);
    } catch (err) {
      log.warn(`handleLogs failed for ${signature}`, msg(err));
    }
  }

  /** Backfill path: fetch a tx's logs and decode. */
  private async processSignature(signature: string): Promise<void> {
    try {
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 2,
        commitment: "confirmed",
      });
      const logs = tx?.meta?.logMessages ?? [];
      if (logs.length) {
        const events = decodeInitializePoolEvents(this.dbc.program as any, logs);
        for (const ev of events) {
          await this.emit({ ...ev, signature });
        }
      }
      this.cursor.setCursor(CURSOR_NAME, signature);
    } catch (err) {
      log.warn(`processSignature failed for ${signature}`, msg(err));
    }
  }

  private async emit(l: DetectedLaunch): Promise<void> {
    if (this.seen.has(l.pool)) return;
    this.seen.add(l.pool);
    await this.onLaunch(l);
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export { CURSOR_NAME };
export const _programId: PublicKey = DBC_PROGRAM_ID;
