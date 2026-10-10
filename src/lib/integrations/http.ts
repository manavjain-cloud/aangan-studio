import { createLogger } from "../logging/logger";
import { redactString } from "../logging/redact";

const log = createLogger("http");

export class HttpError extends Error {
  constructor(
    public readonly integration: string,
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`${integration} responded ${status}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
  }
  get isRateLimited() {
    return this.status === 429;
  }
  get isTransient() {
    return this.status === 429 || this.status >= 500;
  }
}

export class NetworkError extends Error {
  constructor(public readonly integration: string, message: string, public readonly timedOut: boolean) {
    super(`${integration} network error: ${message}`);
    this.name = "NetworkError";
  }
}

export interface HttpRequestOptions {
  integration: string;
  url: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network failures. Only enable for idempotent calls (GET, upserts, or keyed writes). */
  retries?: number;
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 30_000);
  const date = Date.parse(h);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(date - Date.now(), 0), 30_000);
}

export async function httpJson<T = unknown>(opts: HttpRequestOptions): Promise<{ status: number; data: T }> {
  const {
    integration, url, method = "GET", headers = {}, body, query, timeoutMs = 8_000, retries = 0, retryBaseMs = 300,
    fetchImpl = fetch,
  } = opts;

  const u = new URL(url);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(u.toString(), {
        method,
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new HttpError(integration, res.status, redactString(text), parseRetryAfter(res.headers.get("retry-after")));
        if (err.isTransient && attempt < retries) {
          lastErr = err;
          const wait = err.retryAfterMs ?? retryBaseMs * 2 ** attempt;
          log.warn("transient http error, retrying", { integration, status: res.status, attempt: attempt + 1, waitMs: wait });
          await sleep(wait);
          continue;
        }
        throw err;
      }
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { status: res.status, data: data as T };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const timedOut = (err as Error)?.name === "AbortError";
      const net = new NetworkError(integration, timedOut ? `timed out after ${timeoutMs}ms` : String((err as Error)?.message ?? err), timedOut);
      if (attempt < retries) {
        lastErr = net;
        await sleep(retryBaseMs * 2 ** attempt);
        continue;
      }
      throw net;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${integration} request failed`);
}
