/**
 * Age labels for paid alerts are resolved when a message is SENT, not when it is
 * queued. A message can wait (held for creator verification, or logged during a
 * dry run) and be delivered hours later; a label baked in at queue time would
 * then claim "1 min ago" about a payment that is hours old.
 *
 * The queued text carries a marker with the payment time (epoch ms); the outbox
 * worker swaps it for the real age just before delivery.
 */
const MARK = "\u0001";
const MARKER_RE = /\u0001PAID:(\d+)\u0001/g;

/** Alerts older than this are labelled as late so a catch-up is not mistaken for live. */
export const LATE_AFTER_MS = 5 * 60_000;

/** "5 min ago" / "2 h 10 min ago" for a paymentTimestamp in epoch ms. */
export function formatAge(paidAtMs: number, nowMs: number): string {
  const min = Math.max(0, Math.round((nowMs - paidAtMs) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min ago` : `${h} h ago`;
}

export function paidMarker(paidAtMs: number): string {
  return `${MARK}PAID:${Math.round(paidAtMs)}${MARK}`;
}

/** Replace every paid-age marker in `text` with the age as of `nowMs`. */
export function resolvePaidAge(text: string, nowMs: number): string {
  return text.replace(MARKER_RE, (_m, ms: string) => {
    const paid = Number(ms);
    const late = nowMs - paid > LATE_AFTER_MS ? " (late catch-up)" : "";
    return `Paid: ${formatAge(paid, nowMs)}${late}`;
  });
}
