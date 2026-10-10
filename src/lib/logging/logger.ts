import { redact } from "./redact";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function threshold(): number {
  const l = (process.env.LOG_LEVEL ?? "info") as Level | "silent";
  return ORDER[l] ?? ORDER.info;
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: Level, scope: string, bindings: Record<string, unknown>, msg: string, ctx?: Record<string, unknown>) {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(redact({ ...bindings, ...ctx }) as Record<string, unknown>),
  });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export function createLogger(scope: string, bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, c) => emit("debug", scope, bindings, m, c),
    info: (m, c) => emit("info", scope, bindings, m, c),
    warn: (m, c) => emit("warn", scope, bindings, m, c),
    error: (m, c) => emit("error", scope, bindings, m, c),
    child: (b) => createLogger(scope, { ...bindings, ...b }),
  };
}
