import { project } from "@/transit/path";

import { ALERTS_URL, POSITIONS_URL } from "./config";
import { pathOf, type Transit } from "./data";
import { decodeAlerts, decodeVehicles, type Decoded, type FeedAlert, type VehicleFix } from "./gtfs-rt";

/** TransMilenio regenerates the feed every 20 s or so; asking more often only spends the rider's data. */
const POSITIONS_TTL_MS = 15_000;
const ALERTS_TTL_MS = 2 * 60_000;
/** A recent answer, which says how old it is, beats an error when the feed stumbles. */
const GRACE_MS = 90_000;
/** Past this, the feed has stopped and positions are not shown as live. */
export const STALE_AFTER_S = 5 * 60;

function getBytes(url: string, timeoutMs: number): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "arraybuffer";
    xhr.timeout = timeoutMs;
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 && xhr.response ? resolve(xhr.response as ArrayBuffer) : reject(new Error(`http_${xhr.status}`)));
    xhr.onerror = () => reject(new Error("network"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.send();
  });
}

function cachedFeed<T>(url: string, ttlMs: number, decode: (bytes: ArrayBuffer) => Decoded<T>) {
  let last: { at: number; value: Decoded<T> } | null = null;
  let inFlight: Promise<Decoded<T> | null> | null = null;
  return (): Promise<Decoded<T> | null> => {
    if (last && Date.now() - last.at < ttlMs) return Promise.resolve(last.value);
    inFlight ??= getBytes(url, 20_000)
      .then((bytes) => {
        const value = decode(bytes);
        last = { at: Date.now(), value };
        return value;
      })
      .catch(() => (last && Date.now() - last.at < GRACE_MS ? last.value : null))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

export const positions = cachedFeed<VehicleFix>(POSITIONS_URL, POSITIONS_TTL_MS, decodeVehicles);
export const alerts = cachedFeed<FeedAlert>(ALERTS_URL, ALERTS_TTL_MS, decodeAlerts);

export function isFresh(timestamp: number | null, now = Date.now()): boolean {
  return timestamp != null && now / 1000 - timestamp <= STALE_AFTER_S;
}

// ------------------------------------------------------------ matching buses to their line

/** Further than this from every line of its route, a bus is off its route and not placed on one. */
const ON_LINE_M = 90;

export interface Placement {
  pattern: number;
  /** Metres along the pattern's line. */
  along: number;
}

const placed = new Map<string, { timestamp: number | null; placement: Placement | null; along: Map<number, number> }>();

/**
 * Which way a bus is running and how far along its line it is. The realtime trip ids no longer
 * match the published timetable, so this reads it from the bus itself: the lines it sits on, the
 * stop it says it is heading to, and whether it moved forward along a line since its last report.
 */
export function place(t: Transit, v: VehicleFix): Placement | null {
  const route = v.routeId == null ? undefined : t.routeIndex.get(v.routeId);
  if (route === undefined) return null;
  const memo = placed.get(v.id);
  if (memo && memo.timestamp === v.timestamp) return memo.placement;

  const stopIndex = v.stopId == null ? undefined : t.stopIndex.get(v.stopId);
  const candidates: { pattern: number; along: number; offset: number; score: number }[] = [];
  for (const pi of t.routePatterns[route] ?? []) {
    const p = t.patterns[pi]!;
    const hit = project(pathOf(p), [v.lon, v.lat]);
    if (!hit || hit.offset > ON_LINE_M) continue;
    let score = hit.offset;
    if (stopIndex !== undefined) {
      const k = p.stops.indexOf(stopIndex);
      if (k >= 0 && p.dist[k]! >= hit.along - 80) score -= 60;
    }
    const before = memo?.along.get(pi);
    if (before !== undefined) {
      if (hit.along > before + 5) score -= 40;
      else if (hit.along < before - 30) score += 40;
    }
    candidates.push({ pattern: pi, along: hit.along, offset: hit.offset, score });
  }
  candidates.sort((a, b) => a.score - b.score || t.patterns[b.pattern]!.perWeek - t.patterns[a.pattern]!.perWeek);
  const best = candidates[0];
  const placement = best ? { pattern: best.pattern, along: best.along } : null;
  placed.set(v.id, { timestamp: v.timestamp, placement, along: new Map(candidates.map((c) => [c.pattern, c.along])) });
  if (placed.size > 6_000) placed.delete(placed.keys().next().value as string);
  return placement;
}

/** Scheduled seconds from the start of the trip at a point `along` the pattern, read off its stops. */
export function scheduledAt(dist: number[], offsets: number[], along: number): number {
  if (along <= dist[0]!) return offsets[0]!;
  for (let k = 1; k < dist.length; k++) {
    if (along <= dist[k]!) {
      const span = dist[k]! - dist[k - 1]!;
      const f = span > 0 ? (along - dist[k - 1]!) / span : 1;
      return offsets[k - 1]! + f * (offsets[k]! - offsets[k - 1]!);
    }
  }
  return offsets[offsets.length - 1]!;
}
