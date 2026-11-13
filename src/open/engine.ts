/**
 * The answers the app's screens ask for, worked out on the phone from
 * TransMilenio's open data. It stands where Croma's API used to: same shapes
 * as the old /api routes, no key and no server.
 */
import { humanizeAlert } from "@/transit/alerts";
import { dedupeRoutes } from "@/transit/codes";
import { metresBetween } from "@/transit/path";
import type { Alert, Arrival, Bus, Feed, Health, IncomingBus, Nearby, RouteDetail, SearchResult, Stop, StopDetail } from "@/transit/types";

import { activeServices, fold, pathOf, serviceDay, startsOf, transit, type StopInfo, type Transit } from "./data";
import type { FeedAlert, VehicleFix } from "./gtfs-rt";
import { alerts as alertsFeed, isFresh, place, positions, scheduledAt } from "./realtime";

const NEARBY_RADIUS_M = 700;
const NEARBY_LIMIT = 25;
const INCOMING_RADIUS_M = 3_000;
/** How far ahead the timetable is read for a stop. */
const SCHEDULE_WINDOW_S = 90 * 60;
const LIVE_WINDOW_S = 60 * 60;

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function feedOf(timestamp: number | null): Feed {
  return { asOf: timestamp ? iso(timestamp) : new Date().toISOString(), live: isFresh(timestamp) };
}

/** Stations stand for their platforms in lists; a platform is still reachable by its id. */
function listed(s: StopInfo): boolean {
  return s.station || s.parent < 0;
}

function members(t: Transit, s: StopInfo): number[] {
  return [s.index, ...t.children[s.index]!];
}

function toStop(t: Transit, s: StopInfo, distanceM: number | null): Stop {
  const routes = dedupeRoutes(t.stopRoutes[s.index]!.map((r) => t.routes[r]!)).sort((a, b) => a.code.localeCompare(b.code, "es", { numeric: true }));
  return {
    id: s.id,
    name: s.name,
    kind: s.station ? "station" : "stop",
    lat: s.lat,
    lon: s.lon,
    accessible: s.accessible,
    distanceM: distanceM == null ? null : Math.round(distanceM),
    routes,
  };
}

export async function nearby(lat: number, lon: number): Promise<Nearby> {
  const t = await transit();
  const near: { s: StopInfo; d: number }[] = [];
  for (const s of t.stops) {
    if (!listed(s) || t.stopRoutes[s.index]!.length === 0) continue;
    if (Math.abs(s.lat - lat) > 0.01 || Math.abs(s.lon - lon) > 0.01) continue;
    const d = metresBetween([lon, lat], [s.lon, s.lat]);
    if (d <= NEARBY_RADIUS_M) near.push({ s, d });
  }
  near.sort((a, b) => a.d - b.d);
  return { stops: near.slice(0, NEARBY_LIMIT).map(({ s, d }) => toStop(t, s, d)) };
}

export async function search(query: string): Promise<SearchResult> {
  const t = await transit();
  const q = fold(query);
  if (q.length < 2) return { stops: [], routes: [] };
  const words = q.split(" ");
  const code = q.replace(/[\s-]/g, "");

  const routes = t.routes
    .map((r, i) => {
      const text = t.routeSearch[i]!;
      const exact = r.aliases.some((a) => fold(a).replace(/[\s-]/g, "") === code) || fold(r.feedCode) === code;
      const starts = r.aliases.some((a) => fold(a).startsWith(code));
      const all = words.every((w) => text.includes(w));
      return { r, i, rank: exact ? 0 : starts ? 1 : all ? 2 : 9 };
    })
    .filter((x) => x.rank < 9 && t.routePatterns[x.i]!.length > 0)
    .sort((a, b) => a.rank - b.rank || a.r.code.length - b.r.code.length || a.r.code.localeCompare(b.r.code, "es", { numeric: true }))
    .slice(0, 15)
    .map((x) => x.r);

  const stops = t.stops
    .filter((s) => listed(s) && t.stopRoutes[s.index]!.length > 0)
    .map((s) => {
      const text = t.stopSearch[s.index]!;
      const name = fold(s.name);
      const rank = name === q ? 0 : name.startsWith(q) ? 1 : words.every((w) => text.includes(w)) ? 2 : 9;
      return { s, rank };
    })
    .filter((x) => x.rank < 9)
    .sort((a, b) => a.rank - b.rank || Number(b.s.station) - Number(a.s.station) || a.s.name.localeCompare(b.s.name, "es"))
    .slice(0, 15)
    .map((x) => toStop(t, x.s, null));

  return { stops, routes: dedupeRoutes(routes) };
}

// ------------------------------------------------------------ alerts

function activeAlert(a: FeedAlert, nowS: number): boolean {
  return (a.start == null || a.start <= nowS) && (a.end == null || a.end >= nowS);
}

function toAlert(t: Transit, a: FeedAlert): Alert {
  const routes = [...new Set(a.routeIds.flatMap((id) => {
    const r = t.routeIndex.get(id);
    return r === undefined ? [] : [t.routes[r]!.code];
  }))];
  const { title, detail, places, note } = humanizeAlert({ effect: a.effect, description: a.description ?? a.header, routes });
  return { id: a.id, effect: a.effect, title, detail, places, note, routes, until: a.end ? iso(a.end) : null };
}

async function alertsWhere(t: Transit, match: (a: FeedAlert) => boolean): Promise<Alert[]> {
  const feed = await within(alertsFeed(), 4_000, null);
  if (!feed) return [];
  const nowS = Date.now() / 1000;
  return feed.items.filter((a) => activeAlert(a, nowS) && match(a)).slice(0, 20).map((a) => toAlert(t, a));
}

function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([work.catch(() => fallback), new Promise<T>((done) => setTimeout(() => done(fallback), ms))]);
}

// ------------------------------------------------------------ buses

function nextStopName(t: Transit, v: VehicleFix): string | null {
  const at = place(t, v);
  if (at) {
    const p = t.patterns[at.pattern]!;
    const k = p.dist.findIndex((d) => d >= at.along - 15);
    if (k >= 0) return t.stops[p.stops[k]!]!.name;
  }
  const s = v.stopId == null ? undefined : t.stopIndex.get(v.stopId);
  return s === undefined ? null : t.stops[s]!.name;
}

function toBus(t: Transit, v: VehicleFix): Bus {
  return {
    id: v.id,
    lat: v.lat,
    lon: v.lon,
    nextStop: nextStopName(t, v),
    plate: v.plate,
    reportedAt: v.timestamp ? iso(v.timestamp) : null,
  };
}

function freshBuses(items: VehicleFix[]): VehicleFix[] {
  const now = Date.now();
  return items.filter((v) => isFresh(v.timestamp, now));
}

// ------------------------------------------------------------ stops

export async function stopDetail(id: string): Promise<StopDetail | null> {
  const t = await transit();
  const index = t.stopIndex.get(id);
  if (index === undefined) return null;
  const s = t.stops[index]!;
  const memberSet = new Set(members(t, s));
  const memberIds = new Set([...memberSet].map((i) => t.stops[i]!.id));
  const serving = new Set(t.stopRoutes[s.index]!);

  const [feed, alerts] = await Promise.all([
    within(positions(), 12_000, null),
    alertsWhere(t, (a) => a.stopIds.some((x) => memberIds.has(x))),
  ]);
  const live = !!feed && isFresh(feed.timestamp);
  const buses = live ? freshBuses(feed.items) : [];
  const nowS = Date.now() / 1000;

  // Live: every fresh bus on a serving route that is on its way to this stop.
  const estimated: Arrival[] = [];
  const liveRoutes = new Set<number>();
  for (const v of buses) {
    const r = v.routeId == null ? undefined : t.routeIndex.get(v.routeId);
    if (r === undefined || !serving.has(r)) continue;
    const at = place(t, v);
    if (!at) continue;
    const p = t.patterns[at.pattern]!;
    let best = Infinity;
    for (let k = 0; k < p.stops.length - 1; k++) {
      if (!memberSet.has(p.stops[k]!) || p.dist[k]! < at.along - 20) continue;
      best = Math.min(best, Math.max(0, p.offsets[k]! - scheduledAt(p.dist, p.offsets, at.along)));
    }
    if (!Number.isFinite(best)) continue;
    const arrivesAt = (v.timestamp ?? nowS) + best;
    if (arrivesAt - nowS > LIVE_WINDOW_S) continue;
    const route = t.routes[r]!;
    liveRoutes.add(r);
    estimated.push({
      routeId: route.id,
      code: route.code,
      aliases: route.aliases,
      name: route.name,
      system: route.system,
      minutes: Math.max(0, Math.round((arrivesAt - nowS) / 60)),
      at: iso(arrivesAt),
      basis: "estimated",
      delaySeconds: null,
      vehicle: v.label,
      plate: v.plate,
    });
  }

  // Timetable: the next departures of routes with no bus seen on its way.
  const scheduled: Arrival[] = [];
  const perRoute = new Map<number, number>();
  const candidates: { r: number; at: number }[] = [];
  const now = Date.now();
  for (const back of [0, 1]) {
    const day = serviceDay(now, back);
    const services = activeServices(t, day);
    const midnightS = day.midnight / 1000;
    for (const m of memberSet) {
      for (const [pi, k] of t.stopPatterns[m]!) {
        const p = t.patterns[pi]!;
        if (liveRoutes.has(p.route) || k === p.stops.length - 1) continue;
        for (const svc of services) {
          for (const start of startsOf(p, svc)) {
            const at = midnightS + start * 60 + p.offsets[k]!;
            if (at < nowS - 30) continue;
            if (at > nowS + SCHEDULE_WINDOW_S) break;
            candidates.push({ r: p.route, at });
          }
        }
      }
    }
  }
  candidates.sort((a, b) => a.at - b.at);
  for (const c of candidates) {
    const count = perRoute.get(c.r) ?? 0;
    if (count >= 3) continue;
    perRoute.set(c.r, count + 1);
    const route = t.routes[c.r]!;
    scheduled.push({
      routeId: route.id,
      code: route.code,
      aliases: route.aliases,
      name: route.name,
      system: route.system,
      minutes: Math.max(0, Math.round((c.at - nowS) / 60)),
      at: iso(c.at),
      basis: "scheduled",
      delaySeconds: null,
      vehicle: null,
      plate: null,
    });
  }

  const arrivals = [...estimated, ...scheduled].sort((a, b) => (a.minutes ?? 999) - (b.minutes ?? 999)).slice(0, 30);

  const incoming: IncomingBus[] = [];
  for (const v of buses) {
    const r = v.routeId == null ? undefined : t.routeIndex.get(v.routeId);
    if (r === undefined || !serving.has(r)) continue;
    if (metresBetween([s.lon, s.lat], [v.lon, v.lat]) > INCOMING_RADIUS_M) continue;
    const route = t.routes[r]!;
    incoming.push({ ...toBus(t, v), code: route.code, system: route.system });
    if (incoming.length >= 40) break;
  }

  return {
    feed: feedOf(feed?.timestamp ?? null),
    stop: toStop(t, s, null),
    arrivals,
    incoming,
    alerts,
  };
}

// ------------------------------------------------------------ routes

function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export async function routeDetail(id: string): Promise<RouteDetail | null> {
  const t = await transit();
  const r = t.routeIndex.get(id);
  if (r === undefined) return null;
  const list = t.routePatterns[r]!;
  if (list.length === 0) return null;
  const route = t.routes[r]!;
  const main = t.patterns[list[0]!]!;

  const today = activeServices(t, serviceDay(Date.now()));
  let first: number | null = null;
  let last: number | null = null;
  let perWeek = 0;
  for (const pi of list) {
    const p = t.patterns[pi]!;
    perWeek += p.perWeek;
    const services = Object.keys(p.starts).filter((svc) => today.size === 0 || today.has(svc));
    for (const svc of services) {
      const starts = startsOf(p, svc);
      if (!starts.length) continue;
      first = first == null ? starts[0]! : Math.min(first, starts[0]!);
      last = last == null ? starts[starts.length - 1]! : Math.max(last, starts[starts.length - 1]!);
    }
  }

  const [feed, alerts] = await Promise.all([within(positions(), 12_000, null), alertsWhere(t, (a) => a.routeIds.includes(id))]);
  const live = !!feed && isFresh(feed.timestamp);
  const buses = live ? freshBuses(feed.items).filter((v) => v.routeId === id).map((v) => toBus(t, v)) : [];

  return {
    feed: feedOf(feed?.timestamp ?? null),
    route: {
      ...route,
      firstDeparture: first == null ? null : hhmm(first),
      lastDeparture: last == null ? null : hhmm(last),
      tripsPerWeek: perWeek || null,
    },
    path: pathOf(main).points,
    patterns: list.slice(0, 4).map((pi) => {
      const p = t.patterns[pi]!;
      return { path: pathOf(p).points, stops: p.stops.map((s) => t.stops[s]!.id) };
    }),
    stops: main.stops.map((s) => {
      const stop = t.stops[s]!;
      return { id: stop.id, name: stop.name, lat: stop.lat, lon: stop.lon };
    }),
    buses,
    alerts,
  };
}

export async function health(): Promise<Health> {
  const feed = await within(positions(), 15_000, null);
  return { feed: feedOf(feed?.timestamp ?? null) };
}
