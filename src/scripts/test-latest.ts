import { Connection } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { DbcClient, DBC_PROGRAM_ID, decodeInitializePoolEvents } from "../solana/dbc.js";
import { fetchOrders, fetchTokenInfo } from "../dexscreener/client.js";
import { TelegramClient, escapeHtml, clampMessage } from "../telegram.js";

/**
 * One-shot test: find the most recent DBC launch on-chain, gather its DEX
 * Screener state, and send ONE labelled TEST message to Telegram.
 *
 * Sends a real message regardless of DRY_RUN (that is the point of the test),
 * but requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to be set.
 *
 *   npm run test-latest
 */
async function main() {
  const cfg = loadConfig(false);
  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first.");
    process.exit(1);
  }

  const connection = new Connection(cfg.heliusRpcUrl, "confirmed");
  const dbc = new DbcClient(connection);

  console.log("scanning recent DBC program transactions for the latest launch…");
  const sigs = await connection.getSignaturesForAddress(DBC_PROGRAM_ID, { limit: 100 });

  let found: { pool: string; baseMint: string; creator: string; signature: string } | null = null;
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 2,
      commitment: "confirmed",
    });
    const logs = tx?.meta?.logMessages ?? [];
    const events = decodeInitializePoolEvents(dbc.program as any, logs);
    if (events.length > 0) {
      found = { ...events[0]!, signature: s.signature };
      break; // signatures are newest-first, so the first match is the latest launch
    }
  }

  if (!found) {
    console.error("No InitializePool event found in the last 100 txs. Try again later.");
    process.exit(1);
  }

  console.log("latest launch:", found);

  // Eligibility (best-effort; unknown if RPC can't enumerate).
  let launchCount: number | null = null;
  let eligibility = "unknown";
  try {
    const pools = await dbc.getPoolsByCreator(found.creator);
    launchCount = new Set(pools.map((p) => p.baseMint)).size;
    eligibility = launchCount <= cfg.maxCreatorLaunches ? "eligible" : "ineligible";
  } catch (e) {
    console.log("creator history unknown:", (e as Error).message);
  }

  // DEX Screener snapshot.
  let orderLine = "none";
  let websites: string[] = [];
  let socials: { type: string; url: string }[] = [];
  try {
    const orders = (await fetchOrders(found.baseMint)).filter((o) => o.type === "tokenProfile");
    orderLine = orders.length ? orders.map((o) => o.status).join(", ") : "none";
  } catch (e) {
    orderLine = "fetch failed: " + (e as Error).message;
  }
  try {
    const info = (await fetchTokenInfo([found.baseMint])).get(found.baseMint);
    if (info?.present) {
      websites = info.websites;
      socials = info.socials;
    }
  } catch {
    /* ignore */
  }

  const lc = launchCount === null ? "unknown" : String(launchCount);
  const text = clampMessage(
    [
      "🧪 <b>TEST — latest DBC launch</b>",
      "",
      `Eligibility: <b>${eligibility}</b> (launches: ${lc}, max ${cfg.maxCreatorLaunches})`,
      `DEX paid profile: ${escapeHtml(orderLine)}`,
      `Websites: ${websites.length ? escapeHtml(websites.join(", ")) : "—"}`,
      `Socials: ${socials.length ? escapeHtml(socials.map((s) => `${s.type}:${s.url}`).join(", ")) : "—"}`,
      "",
      `Token: <code>${escapeHtml(found.baseMint)}</code>`,
      `Creator: <code>${escapeHtml(found.creator)}</code>`,
      `<a href="https://dexscreener.com/solana/${found.baseMint}">DEX Screener</a> · <a href="https://solscan.io/account/${found.baseMint}">Solscan</a>`,
    ].join("\n")
  );

  console.log("\nsending test message to Telegram…\n" + text);
  const tg = new TelegramClient(cfg.telegramBotToken, cfg.telegramChatId);
  await tg.send(text);
  console.log("\n✅ sent. Check your Telegram chat.");
}

main().catch((e) => {
  console.error("test failed:", e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
