/**
 * Every place the app reads from. All of them are public and need no key:
 * the bundle is built by this repo's GitHub Actions from TransMilenio's open
 * GTFS, and the live feeds come straight from TransMilenio.
 */
export const DATA_BASE = "https://bask209.github.io/paradero-abierto";
export const BUNDLE_URL = `${DATA_BASE}/transit-v1.json`;
export const META_URL = `${DATA_BASE}/meta-v1.json`;

export const RT_BASE = "https://gtfs.transmilenio.gov.co";
export const POSITIONS_URL = `${RT_BASE}/positions.pb`;
export const ALERTS_URL = `${RT_BASE}/alerts.pb`;

/** Where riders' reports go, as a prefilled GitHub issue the rider sends from their own account. */
export const REPORTS_REPO = "bask209/paradero-abierto";
