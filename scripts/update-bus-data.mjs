import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dataDir = path.join(root, "data");
const locationDir = path.join(dataDir, "locations");
const allLocationsFile = path.join(locationDir, "all.json");
const routeDir = path.join(dataDir, "routes");
const routeCatalogFile = path.join(dataDir, "route_catalog.json");

const env = process.env;
const parsedApiBaseUrl = env.PARSED_API_BASE_URL || "https://api.statistics.bus.skystar.kr";
const locationUrl = env.LOCATION_API_URL;
const routeUrl = env.ROUTE_STATIONS_API_URL;
const apiKey = env.BUS_API_KEY;
const apiKeyHeader = env.BUS_API_KEY_HEADER || "Authorization";
const routeServiceKey = env.ROUTE_STATIONS_SERVICE_KEY;
const routeServiceKeyParam = env.ROUTE_STATIONS_SERVICE_KEY_PARAM || "serviceKey";
const routeFormat = env.ROUTE_STATIONS_FORMAT || "json";
const startParam = env.LOCATION_START_PARAM || "start_time";
const endParam = env.LOCATION_END_PARAM || "end_time";
const stationLookupParam = env.STATION_LOOKUP_ID_PARAM || env.ROUTE_ID_PARAM || "routeId";
let routeIds = (env.BUS_ROUTE_IDS || "").split(",").map((v) => v.trim()).filter(Boolean);
const now = env.NOW ? new Date(env.NOW) : new Date();
const hours = Number(env.FETCH_HOURS || 6);

const ymd = (date) => date.toISOString().slice(0, 10);
const iso = (date) => date.toISOString();
const kstDate = (date) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(date);
const parseDate = (value) => new Date(String(value).replace(" ", "T").replace(/(\.\d{3})\d+/, "$1"));
const dateKey = (value) => {
  const parsed = parseDate(value);
  const textDate = String(value || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return Number.isNaN(parsed.getTime()) ? (textDate || "") : kstDate(parsed);
};
const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (file, data) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
const arrayFrom = (payload) => Array.isArray(payload)
  ? payload
  : payload?.data || payload?.items || payload?.rows || payload?.response?.msgBody?.busRouteStationList || payload?.response?.body?.items || [];
const text = (value) => String(value ?? "").replace(/<[^>]*>/g, "").trim();

function normalizeLocation(row) {
  return {
    route_id: String(row.route_id ?? row.routeId ?? row.bus_id ?? row.busId ?? ""),
    station_id: String(row.station_id ?? row.stationId ?? ""),
    station_seq: Number(row.station_seq ?? row.stationSeq ?? row.seq ?? 0),
    plate_no: String(row.plate_no ?? row.plateNo ?? row.vehicle_no ?? row.vehicleNo ?? ""),
    retrieved_at: row.retrieved_at ?? row.retrievedAt ?? row.timestamp ?? row.at ?? iso(now),
    remain_seat_num: Number(row.remain_seat_num ?? row.remainSeatNum ?? row.remaining_seats ?? row.remainingSeats ?? row.remainSeatCnt ?? 0),
    eta_minutes: row.eta_minutes ?? row.etaMinutes ?? row.duration_minutes ?? row.durationMinutes ?? null
  };
}

function normalizeStation(row) {
  return {
    station_seq: Number(row.station_seq ?? row.stationSeq ?? row.stationSeqNo ?? row.seq ?? row.seqNo ?? 0),
    station_id: String(row.station_id ?? row.stationId ?? row.stationID ?? ""),
    station_name: String(row.station_name ?? row.stationName ?? row.stationNameKr ?? row.name ?? row.stationNm ?? ""),
    turn_seq: Number(row.turn_seq ?? row.turnSeq ?? 0) || null
  };
}

function xmlItems(xml) {
  return [...xml.matchAll(/<busRouteStationList>([\s\S]*?)<\/busRouteStationList>/g)]
    .map((match) => Object.fromEntries([...match[1].matchAll(/<([^/][^>]*)>([\s\S]*?)<\/\1>/g)]
      .map(([, key, value]) => [key, text(value)])));
}

function dedupe(rows) {
  return [...new Map(rows.map((row) => [
    [row.route_id, row.plate_no, row.retrieved_at, row.station_seq].join("|"),
    row
  ])).values()];
}

function splitByDate(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = dateKey(row.retrieved_at);
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  return grouped;
}

async function fetchJson(url, params) {
  const request = new URL(url);
  for (const [key, value] of Object.entries(params)) request.searchParams.set(key, value);
  const headers = apiKey
    ? { [apiKeyHeader]: apiKeyHeader.toLowerCase() === "authorization" ? `Bearer ${apiKey}` : apiKey }
    : {};
  const res = await fetch(request, { headers: { "User-Agent": "Mozilla/5.0", ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${request}`);
  return res.json();
}

async function fetchParsedLocations(routeId, from, to) {
  const base = parsedApiBaseUrl || locationUrl;
  const request = new URL(`${base.replace(/\/$/, "")}/api/busLocations/${routeId}`);
  request.searchParams.set("from", from);
  request.searchParams.set("to", to);
  const payload = await fetchJson(request, {});
  return arrayFrom(payload).map((row) => ({ ...row, routeId }));
}

async function fetchLocations(start, end) {
  if (parsedApiBaseUrl) {
    if (!routeIds.length) throw new Error("BUS_ROUTE_IDS is required for PARSED_API_BASE_URL.");
    const from = kstDate(start);
    const to = kstDate(end);
    const rows = await Promise.all(routeIds.map((routeId) => fetchParsedLocations(routeId, from, to)));
    return rows.flat();
  }
  return arrayFrom(await fetchJson(locationUrl, { [startParam]: iso(start), [endParam]: iso(end) }));
}

async function fetchRouteStations(routeId) {
  if (parsedApiBaseUrl && !routeUrl) {
    return arrayFrom(await fetchJson(`${parsedApiBaseUrl.replace(/\/$/, "")}/api/busRouteStations/${routeId}`, {}));
  }
  const apiUrl = routeUrl || "https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteStationListv2";
  const params = { [stationLookupParam]: routeId, format: routeFormat };
  if (routeServiceKey) params[routeServiceKeyParam] = routeServiceKey;
  const request = new URL(apiUrl);
  for (const [key, value] of Object.entries(params)) request.searchParams.set(key, value);
  const res = await fetch(request, { headers: { "User-Agent": "Mozilla/5.0" } });
  const body = res.ok
    ? await res.text()
    : execFileSync("curl", ["-fsSL", "-A", "Mozilla/5.0", request.toString()], { encoding: "utf8" });
  if (body.trim().startsWith("{") || body.trim().startsWith("[")) return arrayFrom(JSON.parse(body));
  return xmlItems(body);
}

async function update() {
  await mkdir(locationDir, { recursive: true });
  await mkdir(routeDir, { recursive: true });
  const oldIndex = await readJson(path.join(dataDir, "index.json"), { dates: [], routes: [] });
  if (!routeIds.length) routeIds = (oldIndex.routes || []).map(String).filter(Boolean);
  if (process.argv.includes("--routes-only")) {
    await updateRoutes(routeIds);
    return;
  }
  if (!parsedApiBaseUrl && !locationUrl) throw new Error("LOCATION_API_URL or PARSED_API_BASE_URL is required.");

  const end = now;
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  const locationRows = (await fetchLocations(start, end))
    .map(normalizeLocation)
    .filter((row) => row.route_id && row.station_seq && row.retrieved_at);

  const allRows = dedupe([...await readJson(allLocationsFile, []), ...locationRows])
    .sort((a, b) => parseDate(a.retrieved_at) - parseDate(b.retrieved_at));
  await writeJson(allLocationsFile, allRows);

  const routes = [...new Set([...routeIds, ...locationRows.map((row) => row.route_id)])].sort();
  await updateRoutes(routes);

  const dates = [...new Set([...(oldIndex.dates || []), ...splitByDate(allRows).keys()])].sort();
  await writeJson(path.join(dataDir, "index.json"), { updated_at: iso(now), dates, routes });
}

async function updateRoutes(routes) {
  if (!routes.length) throw new Error("BUS_ROUTE_IDS is required for --routes-only.");
  const catalog = await readJson(routeCatalogFile, []);
  for (const routeId of routes) {
    const stations = (await fetchRouteStations(routeId))
      .map(normalizeStation)
      .filter((row) => row.station_seq && row.station_name)
      .sort((a, b) => a.station_seq - b.station_seq);
    const meta = catalog.find((route) => String(route.route_id) === String(routeId)) || {};
    const turnSeq = stations.find((station) => String(station.station_id) === String(meta.end_station_id))?.station_seq
      || stations.find((station) => Number(station.turn_seq))?.turn_seq
      || null;
    if (stations.length) {
      await writeJson(path.join(routeDir, `${routeId}.json`), stations.map((station) => ({ ...station, turn_seq: turnSeq })));
    }
  }
}

function selfCheck() {
  const rows = [
    normalizeLocation({ route_id: 1, plate_no: "A", station_seq: 2, retrieved_at: "2026-07-12T15:00:00.000Z", remain_seat_num: 0 }),
    normalizeLocation({ route_id: 1, plate_no: "A", station_seq: 2, retrieved_at: "2026-07-12T15:00:00.000Z", remain_seat_num: 0 }),
    normalizeLocation({ route_id: 1, plate_no: "B", station_seq: 3, retrieved_at: "2026-07-13T01:00:00.000Z", remain_seat_num: 4 })
  ];
  assert.equal(dedupe(rows).length, 2);
  assert.deepEqual([...splitByDate(rows).keys()], ["2026-07-13"]);
  const specRow = normalizeLocation({ routeId: 1, plateNo: "BUS1234", at: "2026-06-30T23:15:00Z", stationSeq: 18, remainSeatCnt: 12 });
  assert.equal(specRow.retrieved_at, "2026-06-30T23:15:00Z");
  assert.equal(specRow.remain_seat_num, 12);
  assert.equal(dateKey(specRow.retrieved_at), "2026-07-01");
  assert.deepEqual(xmlItems("<busRouteStationList><stationSeq>7</stationSeq><stationId>1</stationId><stationName>Test</stationName></busRouteStationList>"), [
    { stationSeq: "7", stationId: "1", stationName: "Test" }
  ]);
}

selfCheck();
if (!process.argv.includes("--self-check")) update();
