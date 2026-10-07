import { Connection } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { DbcClient } from "./solana/dbc.js";
import { LaunchWatcher, type DetectedLaunch } from "./solana/launch-watcher.js";
import { evaluateCreator } from "./solana/creator-history.js";
import { backfillRecentLaunches } from "./solana/backfill-launches.js";
import { PollScheduler } from "./scheduler.js";
import { OutboxWorker } from "./outbox.js";
import {
  TelegramClient,
  DryRunSender,
  type TelegramSender,
} from "./telegram.js";
import {
  formatLaunch,
  makeOrderFormatter,
  makeSocialFormatter,
} from "./format.js";
import { eventKey, type TrackerDeps } from "./tracker.js";
import { log } from "./logger.js";

const BACKFILL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

async function main() {
  const cfg = loadConfig(true);
  log.info(
    `starting DBC tracker (dryRun=${cfg.dryRun}, maxLaunches=${cfg.maxCreatorLaunches}, watch=${cfg.watchWindowMs / 60000}min)`
  );

  const db = new Db(cfg.databasePath);
  const connection = new Connection(cfg.heliusRpcUrl, {
    commitment: "confirmed",
    wsEndpoint: cfg.heliusWsUrl || undefined,
  });
  const dbc = new DbcClient(connection);

  // creatorOf lookup for formatters (reads cached creators table).
  const creatorOf = (mint: string) => {
    const launch = db.getLaunchByMint(mint);
    const creator = launch?.creator ?? "";
    const row = creator ? db.getCreator(creator) : undefined;
    return { creator, launchCount: row?.launch_count ?? null };
  };

  const deps: TrackerDeps = {
    db,
    formatOrder: makeOrderFormatter(creatorOf),
    formatSocial: makeSocialFormatter(creatorOf),
  };

  const sender: TelegramSender = cfg.dryRun
    ? new DryRunSender()
    : new TelegramClient(cfg.telegramBotToken, cfg.telegramChatId);

  // --- launch handler: eligibility gate + start tracking ---
  const onLaunch = async (l: DetectedLaunch) => {
    const result = await evaluateCreator(db, dbc, l.creator, cfg.maxCreatorLaunches);
    log.info(
      `launch ${l.baseMint} by ${l.creator}: eligibility=${result.eligibility} count=${result.launchCount ?? "?"}`
    );
    if (result.eligibility !== "eligible") {
      // Not eligible (or unknown): record the launch but don't track/alert.
      db.insertLaunch({
        pool: l.pool,
        base_mint: l.baseMint,
        creator: l.creator,
        signature: l.signature,
        detected_at: Date.now(),
        watch_until: 0,
        eligible: false,
      });
      return;
    }
    const inserted = db.insertLaunch({
      pool: l.pool,
      base_mint: l.baseMint,
      creator: l.creator,
      signature: l.signature,
      detected_at: Date.now(),
      watch_until: Date.now() + cfg.watchWindowMs,
      eligible: true,
    });
    // Launch alerts are opt-in: by default the token is tracked silently and the
    // user only hears about it when it buys a paid profile or changes socials.
    if (inserted && cfg.alertOnLaunch) {
      db.enqueueEvent({
        eventKey: eventKey(["launch", l.pool]),
        baseMint: l.baseMint,
        kind: "launch",
        text: formatLaunch(l, result.launchCount),
      });
    }
  };

  const watcher = new LaunchWatcher(connection, dbc, db, onLaunch);
  const scheduler = new PollScheduler(db, deps, {
    ordersRpm: cfg.ordersRpm,
    tokensRpm: cfg.tokensRpm,
    pollIntervalMs: 60_000,
  });
  const outbox = new OutboxWorker(db, sender);

  const shutdown = () => {
    log.info("shutting down…");
    watcher.stop();
    scheduler.stop();
    outbox.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await watcher.start();
  void scheduler.runForever();
  void outbox.runForever();

  // Optional: pick up launches from the last 24h that happened before this
  // process started. OFF by default (BACKFILL_MAX_TX=0): the DBC program does
  // ~1000 tx per 30s, so a signature scan only reaches back minutes and costs
  // thousands of getTransaction calls per restart. Runs in the background so
  // live detection is never delayed; the scheduler records each launch's
  // baseline silently before alerting on any change.
  if (cfg.backfillMaxTx > 0) {
    void backfillRecentLaunches(db, connection, dbc, {
      lookbackMs: BACKFILL_LOOKBACK_MS,
      watchWindowMs: cfg.watchWindowMs,
      maxLaunchesPerCreator: cfg.maxCreatorLaunches,
      maxTransactions: cfg.backfillMaxTx,
    }).catch((err) =>
      log.warn("backfill-launches failed", err instanceof Error ? err.message : String(err))
    );
  }

  log.info("tracker running. Ctrl-C to stop.");
}

main().catch((err) => {
  log.error("fatal", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
