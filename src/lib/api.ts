import { focusManager, keepPreviousData, QueryClient, useQuery } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { AppState, Platform } from "react-native";

import { REPORTS_REPO } from "@/open/config";
import { onTransitUpdate } from "@/open/data";
import * as engine from "@/open/engine";
import { REPORT_KINDS, type ReportInput, type ReportResult } from "@/transit/report";
import type { Nearby, SearchResult, Stop } from "@/transit/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      staleTime: 10_000,
    },
  },
});

if (Platform.OS !== "web") {
  AppState.addEventListener("change", (state) => focusManager.setFocused(state === "active"));
}

/** A newer timetable arrived in the background: every screen asks again. */
onTransitUpdate(() => void queryClient.invalidateQueries());

/** The engine says null when a stop or route does not exist; screens expect a 404 for that. */
async function found<T>(work: Promise<T | null>): Promise<T> {
  const value = await work;
  if (value === null) throw new ApiError(404, "not_found");
  return value;
}

/** How often an open stop or route asks again. Positions are downloaded at most every 15 s (see src/open/realtime.ts); in between this only redraws times. */
const LIVE = 5_000;

export function useHealth() {
  return useQuery({ queryKey: ["health"], queryFn: () => engine.health(), refetchInterval: 60_000 });
}

export function useNearby(point: { lat: number; lon: number } | null) {
  const lat = point?.lat.toFixed(3);
  const lon = point?.lon.toFixed(3);
  return useQuery({
    queryKey: ["nearby", lat, lon],
    queryFn: () => engine.nearby(Number(lat), Number(lon)),
    enabled: !!point,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

export function useSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ["search", q.toLowerCase()],
    queryFn: () => engine.search(q),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 30 * 60_000,
  });
}

const stopQuery = (id: string) => ({ queryKey: ["stop", id], queryFn: () => found(engine.stopDetail(id)), staleTime: LIVE });
const routeQuery = (id: string) => ({ queryKey: ["route", id], queryFn: () => found(engine.routeDetail(id)), staleTime: LIVE });

export function prefetchStop(id: string) {
  void queryClient.prefetchQuery(stopQuery(id));
}

export function prefetchRoute(id: string) {
  void queryClient.prefetchQuery(routeQuery(id));
}

/** A stop we already know from a list, so its screen can open with a name and a map instead of a blank. */
export function knownStop(id: string | undefined): Stop | undefined {
  if (!id) return undefined;
  for (const [, data] of queryClient.getQueriesData<Nearby | SearchResult>({ predicate: (q) => q.queryKey[0] === "nearby" || q.queryKey[0] === "search" })) {
    const hit = data?.stops.find((s) => s.id === id);
    if (hit) return hit;
  }
  return undefined;
}

export function useStop(id: string | undefined) {
  return useQuery({ ...stopQuery(id ?? ""), enabled: !!id, refetchInterval: LIVE });
}

export function useRoute(id: string | undefined) {
  return useQuery({ ...routeQuery(id ?? ""), enabled: !!id, refetchInterval: LIVE });
}

/**
 * Reports become public GitHub issues. With no server and no token, the rider sends it from
 * their own GitHub account: this opens the issue already written, they only tap "Submit".
 */
export async function sendReport(input: ReportInput): Promise<ReportResult> {
  const c = input.context ?? {};
  const rows = [
    `**Tipo:** ${REPORT_KINDS[input.kind]}`,
    c.stopId ? `**Paradero:** ${c.stopName ?? ""} \`${c.stopId}\``.trim() : null,
    c.routeId ? `**Ruta:** ${c.routeCode ?? ""} \`${c.routeId}\``.trim() : null,
    `**App:** ${input.app.version} · ${input.app.platform}`,
  ].filter(Boolean);
  const title = `${REPORT_KINDS[input.kind]}${c.routeCode ? ` · ${c.routeCode}` : c.stopName ? ` · ${c.stopName}` : ""}`;
  const body = `${input.message}\n\n---\n${rows.join("\n")}`;
  const url = `https://github.com/${REPORTS_REPO}/issues/new?labels=${encodeURIComponent("reporte ciudadano")}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  await WebBrowser.openBrowserAsync(url);
  return { number: 0, url };
}
