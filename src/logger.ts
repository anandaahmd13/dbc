const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const envLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
const threshold = LEVELS[envLevel] ?? LEVELS.info;

function emit(level: Level, msg: string, extra?: unknown) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const payload = extra === undefined ? "" : " " + safe(extra);
  if (level === "error" || level === "warn") console.error(line + payload);
  else console.log(line + payload);
}

function safe(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, replacer);
  } catch {
    return String(v);
  }
}

function replacer(_k: string, val: unknown) {
  if (typeof val === "bigint") return val.toString();
  return val;
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
