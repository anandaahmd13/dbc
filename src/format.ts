import type { SocialDiff, OrderChange } from "./tracker.js";
import type { TokenInfo } from "./dexscreener/client.js";
import type { DetectedLaunch } from "./solana/launch-watcher.js";
import { escapeHtml, clampMessage } from "./telegram.js";

const dexUrl = (mint: string) => `https://dexscreener.com/solana/${mint}`;
const solscanUrl = (addr: string) => `https://solscan.io/account/${addr}`;

function header(emoji: string, title: string): string {
  return `${emoji} <b>${escapeHtml(title)}</b>`;
}

function footer(mint: string, creator: string, launchCount: number | null): string {
  const lc =
    launchCount === null ? "unknown" : String(launchCount);
  return [
    `Token: <code>${escapeHtml(mint)}</code>`,
    `Creator: <code>${escapeHtml(creator)}</code> (launches: ${lc})`,
    `<a href="${dexUrl(mint)}">DEX Screener</a> · <a href="${solscanUrl(mint)}">Solscan</a>`,
  ].join("\n");
}

export function formatLaunch(
  l: DetectedLaunch,
  launchCount: number | null
): string {
  const body = [
    header("🚀", "New DBC launch (eligible)"),
    "",
    footer(l.baseMint, l.creator, launchCount),
  ].join("\n");
  return clampMessage(body);
}

const ORDER_EMOJI: Record<string, string> = {
  approved: "✅",
  processing: "⏳",
  "on-hold": "⏸️",
  cancelled: "❌",
  rejected: "🚫",
};

/** "5 min ago" / "2 h 10 min ago" for a paymentTimestamp in epoch ms. */
export function formatAge(paidAtMs: number, nowMs: number): string {
  const min = Math.max(0, Math.round((nowMs - paidAtMs) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min ago` : `${h} h ago`;
}

/** Alerts older than this are labelled as late so a catch-up is not mistaken for live. */
export const LATE_AFTER_MS = 5 * 60_000;

export function makeOrderFormatter(
  creatorOf: (mint: string) => { creator: string; launchCount: number | null },
  now: () => number = Date.now
) {
  return (mint: string, change: OrderChange, baseline: boolean): string => {
    const { creator, launchCount } = creatorOf(mint);
    const emoji = ORDER_EMOJI[change.status] ?? "💳";
    const title = baseline
      ? "DEX paid profile (first seen)"
      : "DEX paid: Enhanced Token Info";
    const transition = change.previousStatus
      ? `${escapeHtml(change.previousStatus)} → ${escapeHtml(change.status)}`
      : escapeHtml(change.status);
    // paymentTimestamp is epoch milliseconds from the DEX Screener orders API.
    const paid = change.paymentTimestamp;
    const age =
      paid && paid > 0 ? now() - paid : null;
    const lines = [header(emoji, title), `Status: <b>${transition}</b>`];
    if (age !== null) {
      const late = age > LATE_AFTER_MS ? " (late catch-up)" : "";
      lines.push(`Paid: ${escapeHtml(formatAge(paid!, now()))}${late}`);
    }
    const body = [...lines, "", footer(mint, creator, launchCount)].join("\n");
    return clampMessage(body);
  };
}

export function makeSocialFormatter(
  creatorOf: (mint: string) => { creator: string; launchCount: number | null }
) {
  return (mint: string, diff: SocialDiff, baseline: boolean, _info: TokenInfo): string => {
    const { creator, launchCount } = creatorOf(mint);
    const lines: string[] = [];
    lines.push(header("🔗", baseline ? "Socials (first seen)" : "Social / website update"));

    const list = (label: string, items: string[]) => {
      if (items.length === 0) return;
      lines.push(`${label}:`);
      for (const it of items) lines.push(`  • ${escapeHtml(it)}`);
    };
    list("➕ Website added", diff.websitesAdded);
    list("➖ Website removed", diff.websitesRemoved);
    list(
      "➕ Social added",
      diff.socialsAdded.map((s) => `${s.type}: ${s.url}`)
    );
    list(
      "➖ Social removed",
      diff.socialsRemoved.map((s) => `${s.type}: ${s.url}`)
    );

    lines.push("");
    lines.push(footer(mint, creator, launchCount));
    return clampMessage(lines.join("\n"));
  };
}
