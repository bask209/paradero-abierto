/**
 * Just enough protobuf to read TransMilenio's GTFS-Realtime feeds on the phone:
 * vehicle positions and service alerts. No dependencies, no generated code.
 * Field numbers follow https://gtfs.org/realtime/reference/.
 */

type Field = { field: number; wire: number; start: number; end: number; value: number };

class Reader {
  private pos: number;
  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    private readonly end = buf.length,
  ) {
    this.pos = start;
  }

  private varint(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * scale;
      if (byte < 0x80) return result;
      scale *= 128;
    }
    throw new Error("bad varint");
  }

  *fields(): Generator<Field> {
    while (this.pos < this.end) {
      const key = this.varint();
      const field = Math.floor(key / 8);
      const wire = key & 7;
      const start = this.pos;
      let value = 0;
      if (wire === 0) value = this.varint();
      else if (wire === 1) this.pos += 8;
      else if (wire === 2) {
        const length = this.varint();
        const from = this.pos;
        this.pos += length;
        yield { field, wire, start: from, end: this.pos, value: length };
        continue;
      } else if (wire === 5) this.pos += 4;
      else throw new Error(`unsupported wire type ${wire}`);
      yield { field, wire, start, end: this.pos, value };
    }
  }
}

function sub(buf: Uint8Array, f: Field): Reader {
  return new Reader(buf, f.start, f.end);
}

function text(buf: Uint8Array, f: Field): string {
  // UTF-8 by hand: Hermes has no TextDecoder on every version this app supports.
  let out = "";
  let i = f.start;
  while (i < f.end) {
    const a = buf[i++]!;
    let code: number;
    if (a < 0x80) code = a;
    else if (a < 0xe0) code = ((a & 0x1f) << 6) | (buf[i++]! & 0x3f);
    else if (a < 0xf0) code = ((a & 0x0f) << 12) | ((buf[i++]! & 0x3f) << 6) | (buf[i++]! & 0x3f);
    else code = ((a & 0x07) << 18) | ((buf[i++]! & 0x3f) << 12) | ((buf[i++]! & 0x3f) << 6) | (buf[i++]! & 0x3f);
    out += String.fromCodePoint(code);
  }
  return out;
}

function float32(view: DataView, f: Field): number {
  return view.getFloat32(f.start, true);
}

function translated(buf: Uint8Array, f: Field): string | null {
  let first: string | null = null;
  for (const t of sub(buf, f).fields()) {
    if (t.field !== 1 || t.wire !== 2) continue;
    let value: string | null = null;
    let language: string | null = null;
    for (const x of sub(buf, t).fields()) {
      if (x.field === 1) value = text(buf, x);
      else if (x.field === 2) language = text(buf, x);
    }
    if (value && (language === "es" || !language)) return value;
    first ??= value;
  }
  return first;
}

export interface VehicleFix {
  id: string;
  label: string | null;
  plate: string | null;
  routeId: string | null;
  tripId: string | null;
  stopId: string | null;
  lat: number;
  lon: number;
  bearing: number | null;
  /** Seconds since the epoch. */
  timestamp: number | null;
}

export interface FeedAlert {
  id: string;
  effect: string;
  description: string | null;
  header: string | null;
  start: number | null;
  end: number | null;
  routeIds: string[];
  stopIds: string[];
}

export interface Decoded<T> {
  /** Seconds since the epoch, from the feed header. */
  timestamp: number | null;
  items: T[];
}

function header(buf: Uint8Array, f: Field): number | null {
  for (const h of sub(buf, f).fields()) if (h.field === 3 && h.wire === 0) return h.value;
  return null;
}

export function decodeVehicles(bytes: ArrayBuffer): Decoded<VehicleFix> {
  const buf = new Uint8Array(bytes);
  const view = new DataView(bytes);
  let timestamp: number | null = null;
  const items: VehicleFix[] = [];
  for (const top of new Reader(buf).fields()) {
    if (top.field === 1 && top.wire === 2) timestamp = header(buf, top);
    if (top.field !== 2 || top.wire !== 2) continue;
    let entityId = "";
    for (const e of sub(buf, top).fields()) {
      if (e.field === 1 && e.wire === 2) entityId = text(buf, e);
      if (e.field !== 4 || e.wire !== 2) continue;
      const v: VehicleFix = { id: entityId, label: null, plate: null, routeId: null, tripId: null, stopId: null, lat: NaN, lon: NaN, bearing: null, timestamp: null };
      for (const x of sub(buf, e).fields()) {
        if (x.field === 1 && x.wire === 2) {
          for (const t of sub(buf, x).fields()) {
            if (t.field === 1 && t.wire === 2) v.tripId = text(buf, t);
            else if (t.field === 5 && t.wire === 2) v.routeId = text(buf, t);
          }
        } else if (x.field === 2 && x.wire === 2) {
          for (const p of sub(buf, x).fields()) {
            if (p.wire !== 5) continue;
            if (p.field === 1) v.lat = float32(view, p);
            else if (p.field === 2) v.lon = float32(view, p);
            else if (p.field === 3) v.bearing = float32(view, p);
          }
        } else if (x.field === 5 && x.wire === 0) v.timestamp = x.value;
        else if (x.field === 7 && x.wire === 2) v.stopId = text(buf, x);
        else if (x.field === 8 && x.wire === 2) {
          for (const d of sub(buf, x).fields()) {
            if (d.wire !== 2) continue;
            if (d.field === 1) v.id = text(buf, d) || v.id;
            else if (d.field === 2) v.label = text(buf, d);
            else if (d.field === 3) v.plate = text(buf, d);
          }
        }
      }
      if (Number.isFinite(v.lat) && Number.isFinite(v.lon) && v.lat !== 0) items.push(v);
    }
  }
  return { timestamp, items };
}

const EFFECTS: Record<number, string> = {
  1: "no_service",
  2: "reduced_service",
  3: "significant_delays",
  4: "detour",
  5: "additional_service",
  6: "modified_service",
  7: "other_effect",
  8: "unknown",
  9: "stop_moved",
  10: "no_effect",
  11: "accessibility_issue",
};

export function decodeAlerts(bytes: ArrayBuffer): Decoded<FeedAlert> {
  const buf = new Uint8Array(bytes);
  let timestamp: number | null = null;
  const items: FeedAlert[] = [];
  for (const top of new Reader(buf).fields()) {
    if (top.field === 1 && top.wire === 2) timestamp = header(buf, top);
    if (top.field !== 2 || top.wire !== 2) continue;
    let entityId = "";
    for (const e of sub(buf, top).fields()) {
      if (e.field === 1 && e.wire === 2) entityId = text(buf, e);
      if (e.field !== 5 || e.wire !== 2) continue;
      const a: FeedAlert = { id: entityId, effect: "unknown", description: null, header: null, start: null, end: null, routeIds: [], stopIds: [] };
      for (const x of sub(buf, e).fields()) {
        if (x.field === 1 && x.wire === 2) {
          for (const r of sub(buf, x).fields()) {
            if (r.wire !== 0) continue;
            if (r.field === 1) a.start = a.start == null ? r.value : Math.min(a.start, r.value);
            else if (r.field === 2) a.end = a.end == null ? r.value : Math.max(a.end, r.value);
          }
        } else if (x.field === 5 && x.wire === 2) {
          for (const s of sub(buf, x).fields()) {
            if (s.wire !== 2) continue;
            if (s.field === 2) a.routeIds.push(text(buf, s));
            else if (s.field === 5) a.stopIds.push(text(buf, s));
          }
        } else if (x.field === 7 && x.wire === 0) a.effect = EFFECTS[x.value] ?? "unknown";
        else if (x.field === 10 && x.wire === 2) a.header = translated(buf, x);
        else if (x.field === 11 && x.wire === 2) a.description = translated(buf, x);
      }
      items.push(a);
    }
  }
  return { timestamp, items };
}
