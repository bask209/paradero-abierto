import Storage from "expo-sqlite/kv-store";

import { describeRoute } from "@/transit/codes";
import { measure, type LngLat, type MeasuredPath } from "@/transit/path";
import type { RouteRef } from "@/transit/types";

import { BUNDLE_URL, META_URL } from "./config";

/** What scripts/gtfs/build.py writes. Arrays keep the download small. */
interface RawBundle {
  schema: number;
  feedDate: string;
  generated: string;
  /** [route_id, short_name, long_name, system, color] */
  routes: [string, string, string, string, string][];
  /** [stop_id, name, lat, lon, accessible, isStation, parentIndex, stop_code] */
  stops: [string, string, number, number, 0 | 1, 0 | 1, number, string][];
  /** [service_id, "1111100" monday first, start YYYYMMDD, end YYYYMMDD, added dates, removed dates] */
  services: [string, string, string, string, string[], string[]][];
  patterns: RawPattern[];
}

interface RawPattern {
  /** Route index. */
  r: number;
  /** Stop indexes in order. */
  s: number[];
  /** Metres along the line of each stop. */
  d: number[];
  /** Scheduled seconds from the trip's start to each stop. */
  t: number[];
  /** The line, as a precision-5 polyline. */
  g: string;
  /** Trips a week. */
  w: number;
  /** Trip start minutes per service index, delta encoded. */
  n: Record<string, number[]>;
}

export interface StopInfo {
  index: number;
  id: string;
  name: string;
  lat: number;
  lon: number;
  accessible: boolean;
  station: boolean;
  parent: number;
  code: string;
}

export interface Pattern {
  index: number;
  route: number;
  stops: number[];
  dist: number[];
  offsets: number[];
  perWeek: number;
  starts: Record<string, number[]>;
  encoded: string;
}

export interface Transit {
  feedDate: string;
  routes: RouteRef[];
  routeColor: string[];
  routeIndex: Map<string, number>;
  stops: StopInfo[];
  stopIndex: Map<string, number>;
  /** A station's platforms; empty for a plain stop. */
  children: number[][];
  /** Route indexes serving each stop, a station counting its platforms. */
  stopRoutes: number[][];
  /** [pattern index, position in that pattern] for every time a stop appears. */
  stopPatterns: [number, number][][];
  patterns: Pattern[];
  /** Pattern indexes per route, busiest first. */
  routePatterns: number[][];
  services: { days: string; start: string; end: string; add: Set<string>; remove: Set<string> }[];
  /** Lowercase, accent-free text to search each stop and route by. */
  stopSearch: string[];
  routeSearch: string[];
}

const BUNDLE_KEY = "open.bundle.v1";
const VERSION_KEY = "open.bundle.version.v1";
const CHECKED_KEY = "open.bundle.checked.v1";
/** How often to ask whether a newer bundle was published. TransMilenio publishes once a day. */
const CHECK_EVERY_MS = 6 * 60 * 60_000;

const ACCENTS: Record<string, string> = { á: "a", à: "a", ä: "a", â: "a", é: "e", è: "e", ë: "e", ê: "e", í: "i", ì: "i", ï: "i", î: "i", ó: "o", ò: "o", ö: "o", ô: "o", ú: "u", ù: "u", ü: "u", û: "u", ñ: "n", ç: "c" };

/** Lowercase without accents, so "bolivar" finds "Bolívar". By hand: not every Hermes build has String.normalize. */
export function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/[áàäâéèëêíìïîóòöôúùüûñç]/g, (c) => ACCENTS[c] ?? c)
    .replace(/\s+/g, " ")
    .trim();
}

function index(raw: RawBundle): Transit {
  const routes = raw.routes.map(([id, shortName, longName, system]) => describeRoute({ id, shortName, longName, system }));
  const routeIndex = new Map(raw.routes.map((r, i) => [r[0], i]));
  const stops: StopInfo[] = raw.stops.map(([id, name, lat, lon, accessible, station, parent, code], i) => ({
    index: i,
    id,
    name,
    lat,
    lon,
    accessible: accessible === 1,
    station: station === 1,
    parent,
    code,
  }));
  const stopIndex = new Map(stops.map((s) => [s.id, s.index]));
  const children: number[][] = stops.map(() => []);
  for (const s of stops) if (s.parent >= 0) children[s.parent]!.push(s.index);

  const patterns: Pattern[] = raw.patterns.map((p, i) => ({
    index: i,
    route: p.r,
    stops: p.s,
    dist: p.d,
    offsets: p.t,
    perWeek: p.w,
    starts: p.n,
    encoded: p.g,
  }));
  const routePatterns: number[][] = routes.map(() => []);
  const stopPatterns: [number, number][][] = stops.map(() => []);
  const routeSets: Set<number>[] = stops.map(() => new Set());
  for (const p of patterns) {
    routePatterns[p.route]!.push(p.index);
    p.stops.forEach((s, k) => {
      stopPatterns[s]!.push([p.index, k]);
      routeSets[s]!.add(p.route);
      const parent = stops[s]!.parent;
      if (parent >= 0) routeSets[parent]!.add(p.route);
    });
  }
  for (const list of routePatterns) list.sort((a, b) => patterns[b]!.perWeek - patterns[a]!.perWeek);

  const services = raw.services.map(([, days, start, end, add, remove]) => ({ days, start, end, add: new Set(add), remove: new Set(remove) }));

  return {
    feedDate: raw.feedDate,
    routes,
    routeColor: raw.routes.map((r) => r[4]),
    routeIndex,
    stops,
    stopIndex,
    children,
    stopRoutes: routeSets.map((set) => [...set]),
    stopPatterns,
    patterns,
    routePatterns,
    services,
    stopSearch: stops.map((s) => fold(`${s.name} ${s.code} ${s.id}`)),
    routeSearch: routes.map((r) => fold(`${r.aliases.join(" ")} ${r.feedCode} ${r.name}`)),
  };
}

async function download(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parse(text: string): Transit {
  const raw = JSON.parse(text) as RawBundle;
  if (raw.schema !== 1 || !Array.isArray(raw.patterns)) throw new Error("unexpected_bundle");
  return index(raw);
}

let current: Transit | null = null;
let loading: Promise<Transit> | null = null;
const listeners = new Set<() => void>();

/** Called when a newer bundle replaced the one in use, so screens can ask again. */
export function onTransitUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function refresh(knownVersion: string | null): Promise<Transit | null> {
  const meta = JSON.parse(await download(META_URL, 15_000)) as { version?: string };
  await Storage.setItem(CHECKED_KEY, String(Date.now()));
  if (!meta.version || meta.version === knownVersion) return null;
  const text = await download(BUNDLE_URL, 120_000);
  const next = parse(text);
  await Storage.setItem(BUNDLE_KEY, text);
  await Storage.setItem(VERSION_KEY, meta.version);
  return next;
}

async function load(): Promise<Transit> {
  const [text, version, checked] = await Promise.all([Storage.getItem(BUNDLE_KEY), Storage.getItem(VERSION_KEY), Storage.getItem(CHECKED_KEY)]);
  if (text) {
    try {
      const cached = parse(text);
      if (Date.now() - Number(checked ?? 0) > CHECK_EVERY_MS) {
        refresh(version)
          .then((next) => {
            if (!next) return;
            current = next;
            clearPathCache();
            listeners.forEach((l) => l());
          })
          .catch(() => {});
      }
      return cached;
    } catch {
      // A broken copy is downloaded again below.
    }
  }
  const fresh = await refresh(null);
  if (!fresh) throw new Error("no_bundle");
  return fresh;
}

/** The routes, stops and timetables, downloaded once and kept on the phone. */
export function transit(): Promise<Transit> {
  if (current) return Promise.resolve(current);
  loading ??= load().then(
    (t) => {
      current = t;
      loading = null;
      return t;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

// ------------------------------------------------------------ lines

function decodePolyline(encoded: string): LngLat[] {
  const points: LngLat[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < encoded.length) {
    for (let axis = 0; axis < 2; axis++) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    points.push([lon / 1e5, lat / 1e5]);
  }
  return points;
}

let paths = new Map<number, MeasuredPath>();

function clearPathCache() {
  paths = new Map();
  startCache.clear();
}

export function pathOf(p: Pattern): MeasuredPath {
  let path = paths.get(p.index);
  if (!path) {
    path = measure(decodePolyline(p.encoded));
    paths.set(p.index, path);
  }
  return path;
}

// ------------------------------------------------------------ time

/** Bogotá keeps UTC-5 all year. */
const OFFSET_MS = 5 * 60 * 60_000;

export interface ServiceDay {
  /** YYYYMMDD */
  date: string;
  /** Epoch ms of local midnight. */
  midnight: number;
  /** Monday 0 … Sunday 6. */
  weekday: number;
}

export function serviceDay(epochMs: number, daysBack = 0): ServiceDay {
  const local = new Date(epochMs - OFFSET_MS - daysBack * 86_400_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  return {
    date: `${y}${String(m + 1).padStart(2, "0")}${String(d).padStart(2, "0")}`,
    midnight: Date.UTC(y, m, d) + OFFSET_MS,
    weekday: (local.getUTCDay() + 6) % 7,
  };
}

export function activeServices(t: Transit, day: ServiceDay): Set<string> {
  const out = new Set<string>();
  t.services.forEach((s, i) => {
    if (s.remove.has(day.date)) return;
    const regular = s.days[day.weekday] === "1" && day.date >= s.start && day.date <= s.end;
    if (regular || s.add.has(day.date)) out.add(String(i));
  });
  return out;
}

const startCache = new Map<string, number[]>();

/** A pattern's trip start minutes for one service, decoded from the delta list. */
export function startsOf(p: Pattern, service: string): number[] {
  const key = `${p.index}:${service}`;
  let list = startCache.get(key);
  if (!list) {
    list = [];
    let acc = 0;
    for (const delta of p.starts[service] ?? []) {
      acc += delta;
      list.push(acc);
    }
    startCache.set(key, list);
  }
  return list;
}
