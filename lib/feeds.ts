/**
 * GTFS-Realtime feed access for MTA subway + LIRR.
 *
 * The subway and railroad realtime feeds no longer require an API key.
 * If MTA ever moves these endpoints, this is the only file to update.
 */
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const { transit_realtime } = GtfsRealtimeBindings;
export type FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;

const BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds";

/** LIRR trip updates + vehicle positions (single feed). */
export const LIRR_FEED = `${BASE}/lirr%2Fgtfs-lirr`;

/**
 * NYCT subway realtime feeds are sharded by line group.
 * Key = feed suffix, value = routes covered.
 */
const SUBWAY_FEEDS: Record<string, string[]> = {
  "": ["1", "2", "3", "4", "5", "6", "7", "S", "GS"],
  "-ace": ["A", "C", "E", "H", "FS", "SF", "SR"],
  "-bdfm": ["B", "D", "F", "M"],
  "-g": ["G"],
  "-jz": ["J", "Z"],
  "-nqrw": ["N", "Q", "R", "W"],
  "-l": ["L"],
  "-si": ["SI", "SIR"],
};

/** Service alert feeds (JSON flavor of the GTFS-RT alerts). */
export const ALERT_FEEDS = {
  subway: `${BASE}/camsys%2Fsubway-alerts.json`,
  lirr: `${BASE}/camsys%2Flirr-alerts.json`,
} as const;

export function subwayFeedUrlsForRoutes(routes: string[]): string[] {
  const suffixes = new Set<string>();
  for (const route of routes) {
    const r = route.toUpperCase();
    for (const [suffix, covered] of Object.entries(SUBWAY_FEEDS)) {
      if (covered.includes(r)) suffixes.add(suffix);
    }
  }
  // Unknown route -> fall back to all feeds rather than silently missing data.
  if (suffixes.size === 0) return Object.keys(SUBWAY_FEEDS).map((s) => `${BASE}/nyct%2Fgtfs${s}`);
  return [...suffixes].map((s) => `${BASE}/nyct%2Fgtfs${s}`);
}

/* ------------------------------------------------------------------ */
/* Tiny in-memory cache. Serverless instances are reused between       */
/* invocations often enough that a ~25s TTL meaningfully cuts fetches. */
/* ------------------------------------------------------------------ */

const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 25_000;

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Overall budget stays under Vercel Hobby's hard 10s function cap, leaving
 * headroom for protobuf decode / JSON parse after the last byte lands. */
const TOTAL_DEADLINE_MS = 9_000;
const MAX_ATTEMPTS = 3;

async function attemptFetch(url: string, accept: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { accept }, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }
    const cause = err instanceof Error ? (err.cause ?? err.message) : err;
    throw new Error(String(cause));
  } finally {
    clearTimeout(timer);
  }
}

async function safeFetch(url: string, accept: string): Promise<Response> {
  const deadline = Date.now() + TOTAL_DEADLINE_MS;
  let lastErr: string = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // Split what's left evenly across remaining attempts so early retries
    // don't starve later ones.
    const timeoutMs = Math.floor(remaining / (MAX_ATTEMPTS - attempt + 1));

    let res: Response;
    try {
      res = await attemptFetch(url, accept, timeoutMs);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      continue; // network error / timeout: retry
    }

    if (res.ok) return res;
    if (res.status >= 400 && res.status < 500) {
      // Client error won't fix itself on retry.
      throw new Error(`MTA feed request failed (${res.status} ${res.statusText}) for ${url}`);
    }
    lastErr = `${res.status} ${res.statusText}`;
  }
  throw new Error(`MTA feed unreachable after ${MAX_ATTEMPTS} attempts for ${url} (${lastErr})`);
}

export async function fetchProtobufFeed(url: string): Promise<FeedMessage> {
  return cached(url, async () => {
    const res = await safeFetch(url, "application/x-protobuf");
    const buffer = new Uint8Array(await res.arrayBuffer());
    return transit_realtime.FeedMessage.decode(buffer);
  });
}

export async function fetchJsonFeed<T = unknown>(url: string): Promise<T> {
  return cached(url, async () => {
    const res = await safeFetch(url, "application/json");
    return (await res.json()) as T;
  });
}
