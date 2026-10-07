import { Connection } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { DbcClient } from "./solana/dbc.js";
import { LaunchWatcher, type DetectedLaunch } from "./solana/launch-watcher.js";
import { evaluateCreator } from "./solana/creator-history.js";
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
    if (inserted) {
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
  log.info("tracker running. Ctrl-C to stop.");
}

main().catch((err) => {
  log.error("fatal", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
