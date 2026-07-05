/**
 * Generates /data/lirr-stops.json and /data/subway-stops.json from official
 * MTA static datasets. Run with:  npm run build:data
 *
 * - LIRR: static GTFS zip → stops.txt
 * - Subway: MTA "Subway Stations" dataset (data.ny.gov) which maps GTFS stop
 *   ids to human names and the routes serving each station.
 *
 * URL fallbacks are tried in order; MTA occasionally moves these around.
 */
import AdmZip from "adm-zip";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });

const LIRR_GTFS_URLS = [
  "https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip",
  "http://web.mta.info/developers/data/lirr/google_transit.zip",
];

const SUBWAY_STATIONS_URLS = [
  // MTA Subway Stations dataset (CSV export) on the NY Open Data portal
  "https://data.ny.gov/api/views/39hk-dx4f/rows.csv?accessType=DOWNLOAD",
  // Legacy location
  "http://web.mta.info/developers/data/nyct/subway/Stations.csv",
];

/* --------------------------- tiny CSV parser --------------------------- */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
  }
  return rows;
}

function toObjects(rows) {
  const [header, ...rest] = rows;
  const keys = header.map((h) => h.trim().toLowerCase());
  return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

async function fetchFirst(urls, as = "text") {
  let lastErr;
  for (const url of urls) {
    try {
      console.log(`  fetching ${url}`);
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return as === "buffer" ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (err) {
      console.warn(`  failed: ${err.message}`);
      lastErr = err;
    }
  }
  throw new Error(`All URLs failed. Last error: ${lastErr?.message}`);
}

/* -------------------------------- LIRR -------------------------------- */

function hmsToMinutes(hms) {
  const [h, m] = hms.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

async function buildLirr() {
  console.log("Building LIRR stops + schedule…");
  const zipBuffer = await fetchFirst(LIRR_GTFS_URLS, "buffer");
  const zip = new AdmZip(zipBuffer);
  const read = (name) => {
    const entry = zip.getEntry(name);
    return entry ? toObjects(parseCsv(entry.getData().toString("utf8"))) : null;
  };

  /* ---- stops ---- */
  const stopsRaw = read("stops.txt");
  if (!stopsRaw) throw new Error("stops.txt not found in LIRR GTFS zip");
  const stops = stopsRaw
    .filter((s) => s.stop_id && s.stop_name)
    .map((s) => ({ id: s.stop_id, name: s.stop_name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(join(dataDir, "lirr-stops.json"), JSON.stringify(stops, null, 2));
  console.log(`  wrote ${stops.length} LIRR stops`);

  /* ---- service calendar ---- */
  const calendar = {};
  for (const r of read("calendar.txt") ?? []) {
    if (!r.service_id) continue;
    calendar[r.service_id] = {
      // days indexed 0=Sunday … 6=Saturday (matches Date#getUTCDay)
      days: [r.sunday, r.monday, r.tuesday, r.wednesday, r.thursday, r.friday, r.saturday].map(
        (v) => (v === "1" ? 1 : 0)
      ),
      start: r.start_date,
      end: r.end_date,
    };
  }
  const calendarDates = {};
  for (const r of read("calendar_dates.txt") ?? []) {
    if (!r.service_id || !r.date) continue;
    const entry = (calendarDates[r.service_id] ??= { add: [], remove: [] });
    (r.exception_type === "2" ? entry.remove : entry.add).push(r.date);
  }
  console.log(
    `  parsed ${Object.keys(calendar).length} calendar services, ` +
      `${Object.keys(calendarDates).length} services with date exceptions`
  );

  /* ---- trips + stop_times → compact schedule ---- */
  const tripService = new Map();
  for (const r of read("trips.txt") ?? []) {
    if (r.trip_id && r.service_id) tripService.set(r.trip_id, r.service_id);
  }
  const stopTimesRaw = read("stop_times.txt") ?? [];
  console.log(`  parsed ${stopTimesRaw.length} stop_times rows across ${tripService.size} trips`);

  const byTrip = new Map();
  for (const r of stopTimesRaw) {
    if (!r.trip_id || !r.stop_id) continue;
    const arr = hmsToMinutes(r.arrival_time || r.departure_time || "");
    const dep = hmsToMinutes(r.departure_time || r.arrival_time || "");
    if (arr === null || dep === null) continue;
    const list = byTrip.get(r.trip_id) ?? [];
    list.push({ seq: Number(r.stop_sequence ?? list.length), st: [r.stop_id, arr, dep] });
    byTrip.set(r.trip_id, list);
  }

  const trips = [];
  for (const [tripId, list] of byTrip) {
    const serviceId = tripService.get(tripId);
    if (!serviceId) continue;
    // Only keep trips whose service can ever be active.
    if (!calendar[serviceId] && !calendarDates[serviceId]) continue;
    list.sort((a, b) => a.seq - b.seq);
    if (list.length < 2) continue;
    trips.push({ s: serviceId, st: list.map((x) => x.st) });
  }
  if (trips.length < 100) {
    throw new Error(
      `Only assembled ${trips.length} scheduled trips — the GTFS format may have changed. ` +
        `Inspect the zip contents and update scripts/build-stations.mjs.`
    );
  }
  const schedule = { calendar, calendarDates, trips };
  writeFileSync(join(dataDir, "lirr-schedule.json"), JSON.stringify(schedule));
  console.log(`  wrote ${trips.length} scheduled trips to lirr-schedule.json`);
}

/* ------------------------------- Subway ------------------------------- */

async function buildSubway() {
  console.log("Building subway stations…");
  const csv = await fetchFirst(SUBWAY_STATIONS_URLS);
  const records = toObjects(parseCsv(csv));

  // Column names differ slightly between the portal export and the legacy CSV.
  const pick = (r, ...names) => {
    for (const n of names) if (r[n] !== undefined && r[n] !== "") return r[n];
    return "";
  };

  const seen = new Map();
  for (const r of records) {
    const id = pick(r, "gtfs stop id", "gtfs_stop_id");
    const name = pick(r, "stop name", "stop_name");
    if (!id || !name) continue;
    const routes = pick(r, "daytime routes", "daytime_routes")
      .split(/\s+/)
      .filter(Boolean);
    const borough = pick(r, "borough", "borough name", "borough_name");
    // Some complexes appear multiple times; keep first occurrence per GTFS id.
    if (!seen.has(id)) seen.set(id, { id, name, routes, borough });
  }
  const stations = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (stations.length < 100) {
    throw new Error(
      `Only parsed ${stations.length} subway stations — the CSV format may have changed. ` +
        `Inspect the columns and update scripts/build-stations.mjs.`
    );
  }
  writeFileSync(join(dataDir, "subway-stops.json"), JSON.stringify(stations, null, 2));
  console.log(`  wrote ${stations.length} subway stations`);
}

/* -------------------------------- main -------------------------------- */

try {
  await buildLirr();
  await buildSubway();
  console.log("Done. Commit the /data JSON files and deploy.");
} catch (err) {
  console.error(`\nbuild:data failed: ${err.message}`);
  process.exit(1);
}
