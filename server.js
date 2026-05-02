import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
await loadEnvFile(join(root, ".env"));

const publicDir = join(root, "public");
const dataDir = join(root, "data");
const settingsPath = join(dataDir, "settings.json");
const port = Number(process.env.PORT || 3000);
const ltaKey = process.env.LTA_DATAMALL_KEY || process.env.LTA_ACCOUNT_KEY || "";
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramChatId = process.env.TELEGRAM_CHAT_ID || "";
const busStopCacheTtlMs = 24 * 60 * 60 * 1000;
const schedulerIntervalMs = Number(process.env.SCHEDULER_INTERVAL_MS || 20_000);
const boardedSuppressMs = Number(process.env.BOARDED_SUPPRESS_MS || 4 * 60 * 60 * 1000);
const telegramPollMs = Number(process.env.TELEGRAM_POLL_MS || 15_000);

let busStopCache = null;
let busStopCacheLoadedAt = 0;
let serverSettings = null;
let schedulerRunning = false;
let notifiedBuckets = new Map();
let boardedTrips = new Map();
let telegramUpdateOffset = 0;
let telegramPolling = false;

const defaultSettings = {
  officeStop: "09048",
  officeServices: "14, 65, 166",
  officeLeave: "08:45",
  officeWalk: 7,
  officeWindow: 45,
  officeSecondEnabled: false,
  officeSecondStop: "",
  officeSecondServices: "",
  officeRideToSecond: 15,
  officeTransferWalk: 2,
  homeStop: "09047",
  homeServices: "14, 65, 166",
  homeLeave: "18:15",
  homeWalk: 7,
  homeWindow: 45,
  homeSecondEnabled: false,
  homeSecondStop: "",
  homeSecondServices: "",
  homeRideToSecond: 15,
  homeTransferWalk: 2,
  locationEnabled: false,
  homeLat: "",
  homeLng: "",
  officeLat: "",
  officeLng: "",
  locationRadius: 300,
  manualPlace: "",
  autoPoll: true
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

async function loadEnvFile(path) {
  try {
    const body = await readFile(path, "utf8");
    body.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]]) return;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    });
  } catch {
    // .env is optional.
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function loadSettings() {
  if (serverSettings) return serverSettings;

  try {
    const body = await readFile(settingsPath, "utf8");
    serverSettings = { ...defaultSettings, ...JSON.parse(body) };
  } catch {
    serverSettings = { ...defaultSettings };
  }

  return serverSettings;
}

async function saveSettings(nextSettings) {
  serverSettings = { ...defaultSettings, ...nextSettings };
  await mkdir(dataDir, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(serverSettings, null, 2)}\n`);
  return serverSettings;
}

function parseServices(value) {
  return String(value || "")
    .split(",")
    .map((service) => service.trim())
    .filter(Boolean);
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value || "00:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesSinceMidnight(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function getTrips(settings) {
  return [
    {
      id: "office",
      label: "Office",
      stopCode: settings.officeStop,
      services: parseServices(settings.officeServices),
      leaveAt: settings.officeLeave,
      walkMinutes: Number(settings.officeWalk || 0),
      windowMinutes: Number(settings.officeWindow || 45),
      secondLeg: {
        enabled: Boolean(settings.officeSecondEnabled),
        stopCode: settings.officeSecondStop,
        services: parseServices(settings.officeSecondServices),
        rideMinutes: Number(settings.officeRideToSecond || 0),
        transferWalkMinutes: Number(settings.officeTransferWalk || 0)
      }
    },
    {
      id: "home",
      label: "Home",
      stopCode: settings.homeStop,
      services: parseServices(settings.homeServices),
      leaveAt: settings.homeLeave,
      walkMinutes: Number(settings.homeWalk || 0),
      windowMinutes: Number(settings.homeWindow || 45),
      secondLeg: {
        enabled: Boolean(settings.homeSecondEnabled),
        stopCode: settings.homeSecondStop,
        services: parseServices(settings.homeSecondServices),
        rideMinutes: Number(settings.homeRideToSecond || 0),
        transferWalkMinutes: Number(settings.homeTransferWalk || 0)
      }
    }
  ];
}

function activeTrips(settings) {
  const now = minutesSinceMidnight();
  return getTrips(settings).filter((trip) => {
    const leave = timeToMinutes(trip.leaveAt);
    return now >= leave - trip.windowMinutes && now <= leave + trip.windowMinutes;
  });
}

function makeMockArrival(stopCode) {
  const now = Date.now();
  const services = ["14", "65", "111", "133", "147", "166"];

  return {
    source: "demo",
    busStopCode: stopCode,
    fetchedAt: new Date(now).toISOString(),
    services: services.map((service, index) => {
      const base = 4 + ((Math.floor(now / 60000) + index * 3) % 16);
      return {
        serviceNo: service,
        arrivals: [base, base + 8 + (index % 4), base + 17 + (index % 6)].map((minutes) => ({
          minutes,
          estimatedArrival: new Date(now + minutes * 60000).toISOString(),
          load: ["SEA", "SDA", "LSD"][index % 3],
          type: ["SD", "DD", "BD"][index % 3],
          feature: index % 2 === 0 ? "WAB" : ""
        }))
      };
    })
  };
}

function makeMockBusStops() {
  return [
    { code: "09048", roadName: "Orchard Rd", description: "Orchard Stn/Tang Plaza", latitude: 1.30451, longitude: 103.83296 },
    { code: "09047", roadName: "Orchard Rd", description: "Opp Orchard Stn/ION", latitude: 1.30429, longitude: 103.83186 },
    { code: "83139", roadName: "Tampines Ave 5", description: "Tampines Int", latitude: 1.35408, longitude: 103.94339 },
    { code: "75009", roadName: "Changi Airport PTB2", description: "Changi Airport PTB2", latitude: 1.35565, longitude: 103.9886 },
    { code: "03223", roadName: "North Bridge Rd", description: "City Hall Stn Exit B", latitude: 1.29311, longitude: 103.85208 }
  ];
}

function normalizeBusStop(stop) {
  return {
    code: stop.BusStopCode,
    roadName: stop.RoadName,
    description: stop.Description,
    latitude: Number(stop.Latitude),
    longitude: Number(stop.Longitude)
  };
}

async function fetchAllBusStops() {
  if (!ltaKey) return makeMockBusStops();
  if (busStopCache && Date.now() - busStopCacheLoadedAt < busStopCacheTtlMs) return busStopCache;

  const stops = [];

  for (let skip = 0; ; skip += 500) {
    const upstream = await fetch(
      `https://datamall2.mytransport.sg/ltaodataservice/BusStops?$skip=${skip}`,
      {
        headers: {
          AccountKey: ltaKey,
          accept: "application/json"
        }
      }
    );

    if (!upstream.ok) {
      const body = await upstream.text();
      throw new Error(`LTA bus stop search failed: ${body.slice(0, 160)}`);
    }

    const payload = await upstream.json();
    const page = payload.value || [];
    stops.push(...page.map(normalizeBusStop));

    if (page.length < 500) break;
  }

  busStopCache = stops;
  busStopCacheLoadedAt = Date.now();
  return busStopCache;
}

function scoreBusStop(stop, query) {
  const normalizedQuery = query.toLowerCase();
  const haystack = `${stop.code} ${stop.description} ${stop.roadName}`.toLowerCase();
  if (!haystack.includes(normalizedQuery)) return 0;
  if (stop.code === normalizedQuery) return 100;
  if (stop.code.startsWith(normalizedQuery)) return 90;
  if (stop.description.toLowerCase().startsWith(normalizedQuery)) return 80;
  if (stop.roadName.toLowerCase().startsWith(normalizedQuery)) return 70;
  return 40;
}

function normalizeLtaPayload(stopCode, payload) {
  const now = Date.now();

  return {
    source: "lta",
    busStopCode: stopCode,
    fetchedAt: new Date(now).toISOString(),
    services: (payload.Services || []).map((service) => ({
      serviceNo: service.ServiceNo,
      operator: service.Operator,
      arrivals: [service.NextBus, service.NextBus2, service.NextBus3]
        .filter((bus) => bus?.EstimatedArrival)
        .map((bus) => {
          const arrivalTime = new Date(bus.EstimatedArrival).getTime();
          return {
            minutes: Math.max(0, Math.round((arrivalTime - now) / 60000)),
            estimatedArrival: bus.EstimatedArrival,
            load: bus.Load,
            type: bus.Type,
            feature: bus.Feature
          };
        })
    }))
  };
}

async function fetchBusArrivalData(stopCode) {
  if (!ltaKey) return makeMockArrival(stopCode);

  const upstream = await fetch(
    `https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?BusStopCode=${encodeURIComponent(stopCode)}`,
    {
      headers: {
        AccountKey: ltaKey,
        accept: "application/json"
      }
    }
  );

  if (!upstream.ok) {
    const body = await upstream.text();
    throw new Error(`LTA request failed: ${body.slice(0, 400)}`);
  }

  return normalizeLtaPayload(stopCode, await upstream.json());
}

function evaluateArrival(trip, minutes) {
  const spare = minutes - trip.walkMinutes;
  if (spare < 0) {
    return {
      level: "run",
      title: "Run now",
      message: `${trip.label}: bus in ${minutes} min, walk is ${trip.walkMinutes} min. You are already ${Math.abs(spare)} min tight.`
    };
  }
  if (spare <= 2) {
    return {
      level: "run",
      title: "Run faster",
      message: `${trip.label}: bus in ${minutes} min. You have only ${spare} min buffer.`
    };
  }
  if (spare <= 5) {
    return {
      level: "hurry",
      title: "Leave now",
      message: `${trip.label}: bus in ${minutes} min. Brisk walk, ${spare} min buffer.`
    };
  }
  return {
    level: "go",
    title: "Good bus coming",
    message: `${trip.label}: bus in ${minutes} min. You have ${spare} min after the walk.`
  };
}

function canCatch(row) {
  return row.next.minutes >= row.trip.walkMinutes;
}

function clearExpiredBoardedTrips() {
  const now = Date.now();
  boardedTrips = new Map([...boardedTrips].filter(([, until]) => until > now));
}

function isTripBoarded(tripId) {
  clearExpiredBoardedTrips();
  return (boardedTrips.get(tripId) || 0) > Date.now();
}

function markTripBoarded(tripId) {
  const until = Date.now() + boardedSuppressMs;
  boardedTrips.set(tripId, until);
  return until;
}

function isSecondLegReady(trip) {
  return (
    trip.secondLeg?.enabled &&
    trip.secondLeg.stopCode &&
    trip.secondLeg.services.length > 0 &&
    trip.secondLeg.rideMinutes >= 0
  );
}

function minutesBetween(fromDate, toDate) {
  return Math.round((toDate.getTime() - fromDate.getTime()) / 60000);
}

function formatTime(isoOrDate) {
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return new Intl.DateTimeFormat("en-SG", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: process.env.TZ || "Asia/Singapore"
  }).format(date);
}

function findBestConnection(firstArrival, trip, secondServices) {
  if (!isSecondLegReady(trip)) return null;

  const readyAt = new Date(
    new Date(firstArrival.estimatedArrival).getTime() +
      (trip.secondLeg.rideMinutes + trip.secondLeg.transferWalkMinutes) * 60000
  );

  const options = [];
  for (const service of secondServices) {
    for (const arrival of service.arrivals) {
      const arrivesAt = new Date(arrival.estimatedArrival);
      const waitMinutes = minutesBetween(readyAt, arrivesAt);
      if (waitMinutes >= 0) options.push({ service, arrival, readyAt, waitMinutes });
    }
  }

  options.sort((a, b) => a.waitMinutes - b.waitMinutes);
  return options[0] || { readyAt, waitMinutes: null };
}

function evaluateConnection(trip, firstService, firstArrival, connection) {
  const firstAction = evaluateArrival(trip, firstArrival.minutes);
  if (!connection) return firstAction;
  if (!connection.service) {
    return {
      level: "wait",
      title: "Connection unclear",
      message: `${trip.label}: take ${firstService.serviceNo}, reach transfer around ${formatTime(connection.readyAt)}, but no matching second bus is visible yet.`
    };
  }

  const secondNo = connection.service.serviceNo;
  if (connection.waitMinutes <= 2) {
    return {
      level: "run",
      title: "Tight transfer",
      message: `${trip.label}: take ${firstService.serviceNo}, reach transfer around ${formatTime(connection.readyAt)}, then ${secondNo} after ${connection.waitMinutes} min.`
    };
  }

  if (connection.waitMinutes <= 8) {
    return {
      level: "connect",
      title: "Connection works",
      message: `${trip.label}: take ${firstService.serviceNo}, then ${secondNo}. Transfer wait about ${connection.waitMinutes} min.`
    };
  }

  return {
    level: "wait",
    title: "Long transfer wait",
    message: `${trip.label}: take ${firstService.serviceNo}, then ${secondNo}. You may wait about ${connection.waitMinutes} min.`
  };
}

async function fetchTrip(trip) {
  const firstPayload = await fetchBusArrivalData(trip.stopCode);
  let secondPayload = null;

  if (isSecondLegReady(trip)) {
    secondPayload = await fetchBusArrivalData(trip.secondLeg.stopCode);
  }

  return {
    trip,
    source: firstPayload.source,
    services: firstPayload.services.filter((service) => trip.services.includes(service.serviceNo)),
    secondServices: secondPayload
      ? secondPayload.services.filter((service) => trip.secondLeg.services.includes(service.serviceNo))
      : []
  };
}

function findBestRow(results) {
  const rows = [];

  for (const result of results) {
    for (const service of result.services) {
      const next = service.arrivals[0];
      if (!next) continue;
      const connection = findBestConnection(next, result.trip, result.secondServices);
      const action = evaluateConnection(result.trip, service, next, connection);
      rows.push({ trip: result.trip, service, next, action, connection });
    }
  }

  rows.sort((a, b) => {
    const aWait = a.connection?.waitMinutes ?? a.next.minutes;
    const bWait = b.connection?.waitMinutes ?? b.next.minutes;
    return aWait - bWait || a.next.minutes - b.next.minutes;
  });

  return rows[0] || null;
}

function sortCommuteRows(rows) {
  rows.sort((a, b) => {
    const aWait = a.connection?.waitMinutes ?? a.next.minutes;
    const bWait = b.connection?.waitMinutes ?? b.next.minutes;
    return aWait - bWait || a.next.minutes - b.next.minutes;
  });
  return rows;
}

function findCommuteRows(results) {
  const rows = [];

  for (const result of results) {
    for (const service of result.services) {
      for (const arrival of service.arrivals) {
        const connection = findBestConnection(arrival, result.trip, result.secondServices);
        const action = evaluateConnection(result.trip, service, arrival, connection);
        rows.push({ trip: result.trip, service, next: arrival, action, connection });
      }
    }
  }

  return sortCommuteRows(rows);
}

async function sendTelegram(title, message, options = {}) {
  if (!telegramToken || !telegramChatId) {
    console.log(`[notify skipped] ${title}: ${message}`);
    return { skipped: true, reason: "Telegram is not configured" };
  }

  const body = {
    chat_id: telegramChatId,
    text: `${title}\n${message}`
  };

  if (options.replyMarkup) {
    body.reply_markup = options.replyMarkup;
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.description || "Telegram request failed");
  return payload;
}

function shouldNotify(row, { bypassDuplicate = false } = {}) {
  if (!row || !["run", "hurry", "go", "connect"].includes(row.action.level)) return false;

  const arrivalBucket = Math.round(new Date(row.next.estimatedArrival).getTime() / (5 * 60_000));
  const key = `${row.trip.id}:${row.service.serviceNo}:${row.action.level}:${arrivalBucket}`;
  if (!bypassDuplicate && notifiedBuckets.has(key)) return false;

  notifiedBuckets.set(key, Date.now());
  if (notifiedBuckets.size > 200) {
    const cutoff = Date.now() - 2 * 60 * 60_000;
    notifiedBuckets = new Map([...notifiedBuckets].filter(([, ts]) => ts >= cutoff));
  }

  return true;
}

function findNextAlternative(rows, row) {
  return rows.find((candidate) => {
    if (candidate === row) return false;
    if (candidate.trip.id !== row.trip.id) return false;
    const candidateTime = new Date(candidate.next.estimatedArrival).getTime();
    const rowTime = new Date(row.next.estimatedArrival).getTime();
    return candidateTime > rowTime || candidate.service.serviceNo !== row.service.serviceNo;
  });
}

function rowSummary(row) {
  if (!row) return null;
  return {
    trip: row.trip.id,
    title: row.action.title,
    serviceNo: row.service.serviceNo,
    stopCode: row.trip.stopCode,
    minutes: row.next.minutes,
    arrivalTime: formatTime(row.next.estimatedArrival),
    message: row.action.message,
    secondServiceNo: row.connection?.service?.serviceNo || "",
    secondArrivalTime: row.connection?.arrival ? formatTime(row.connection.arrival.estimatedArrival) : "",
    transferWaitMinutes: Number.isFinite(row.connection?.waitMinutes) ? row.connection.waitMinutes : null
  };
}

function notificationMessage(row, alternative = null) {
  const buffer = row.next.minutes - row.trip.walkMinutes;
  const lines = [
    `${row.trip.label} commute`,
    "",
    `${row.action.title}`,
    `Bus ${row.service.serviceNo} in ${row.next.minutes} min (${formatTime(row.next.estimatedArrival)})`,
    `Stop ${row.trip.stopCode}. Walk ${row.trip.walkMinutes} min. Buffer ${buffer} min.`,
    row.action.message
  ];

  if (row.connection?.service) {
    lines.push(
      "",
      `Transfer: ${row.connection.service.serviceNo} at ${formatTime(row.connection.arrival.estimatedArrival)}`,
      `Transfer wait: ${row.connection.waitMinutes} min`
    );
  }

  if (alternative) {
    const altBuffer = alternative.next.minutes - alternative.trip.walkMinutes;
    lines.push("", `Next catchable: bus ${alternative.service.serviceNo} in ${alternative.next.minutes} min (${formatTime(alternative.next.estimatedArrival)}), buffer ${altBuffer} min`);

    if (alternative.connection?.service) {
      lines.push(
        `Then ${alternative.connection.service.serviceNo} at ${formatTime(alternative.connection.arrival.estimatedArrival)}`
      );
    }
  }

  return lines.join("\n");
}

function boardedReplyMarkup(row) {
  return {
    inline_keyboard: [
      [
        {
          text: "Yes, I boarded",
          callback_data: `boarded:${row.trip.id}`
        }
      ]
    ]
  };
}

async function telegramRequest(method, body) {
  if (!telegramToken) return null;
  const response = await fetch(`https://api.telegram.org/bot${telegramToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.description || `Telegram ${method} failed`);
  return payload;
}

async function answerBoardedCallback(callbackQuery, tripId) {
  markTripBoarded(tripId);

  await telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackQuery.id,
    text: "Got it. I will stop alerts for this trip for a few hours."
  });

  if (callbackQuery.message?.chat?.id && callbackQuery.message?.message_id) {
    await telegramRequest("editMessageReplyMarkup", {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id,
      reply_markup: { inline_keyboard: [] }
    });
  }

  console.log(`[boarded] ${tripId} suppressed until ${new Date(boardedTrips.get(tripId)).toISOString()}`);
}

async function pollTelegramUpdates() {
  if (!telegramToken || telegramPolling) return;
  telegramPolling = true;

  try {
    const payload = await telegramRequest("getUpdates", {
      offset: telegramUpdateOffset || undefined,
      timeout: 0,
      allowed_updates: ["callback_query"]
    });

    for (const update of payload.result || []) {
      telegramUpdateOffset = Math.max(telegramUpdateOffset, update.update_id + 1);
      const callback = update.callback_query;
      const data = callback?.data || "";
      if (!data.startsWith("boarded:")) continue;
      await answerBoardedCallback(callback, data.split(":")[1]);
    }
  } catch (error) {
    console.error(`[telegram poll] ${error.message}`);
  } finally {
    telegramPolling = false;
  }
}

async function evaluateCommute({ force = false, notify = false, bypassDuplicate = false } = {}) {
  const settings = await loadSettings();
  const trips = (force ? getTrips(settings) : activeTrips(settings)).filter(
    (trip) => trip.stopCode && trip.services.length > 0 && !isTripBoarded(trip.id)
  );

  if (trips.length === 0) {
    return { ok: true, notified: false, reason: force ? "No configured trips or trip already boarded" : "Outside leave windows or trip already boarded" };
  }

  const results = await Promise.all(trips.map(fetchTrip));
  const rows = findCommuteRows(results);
  const catchableRows = rows.filter(canCatch);
  const best = catchableRows[0] || null;
  const alternative = best ? findNextAlternative(catchableRows, best) : rows[0] || null;

  if (!best) {
    return {
      ok: true,
      notified: false,
      reason: rows.length > 0 ? "No catchable bus based on walk time" : "No matching bus arrivals",
      trips: trips.map((trip) => trip.id),
      missed: rowSummary(alternative)
    };
  }

  const payload = {
    ok: true,
    notified: false,
    best: {
      ...rowSummary(best),
      message: notificationMessage(best, alternative)
    },
    alternative: rowSummary(alternative)
  };

  if (!notify) return payload;
  if (!shouldNotify(best, { bypassDuplicate })) {
    return { ...payload, reason: "Duplicate or not notification-worthy" };
  }

  await sendTelegram(best.action.title, notificationMessage(best, alternative), {
    replyMarkup: boardedReplyMarkup(best)
  });
  console.log(`[notified] ${best.trip.id}: ${best.action.title} ${best.service.serviceNo} in ${best.next.minutes}m`);
  return { ...payload, notified: true };
}

async function runSchedulerTick() {
  if (schedulerRunning) return;
  schedulerRunning = true;

  try {
    await evaluateCommute({ notify: true });
  } catch (error) {
    console.error(`[scheduler] ${error.message}`);
  } finally {
    schedulerRunning = false;
  }
}

async function handleBusStopSearch(req, res, url) {
  const query = url.searchParams.get("query")?.trim() || "";

  if (query.length < 2) {
    json(res, 200, { source: ltaKey ? "lta" : "demo", results: [] });
    return;
  }

  try {
    const results = (await fetchAllBusStops())
      .map((stop) => ({ stop, score: scoreBusStop(stop, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.stop.description.localeCompare(b.stop.description))
      .slice(0, 12)
      .map((item) => item.stop);

    json(res, 200, { source: ltaKey ? "lta" : "demo", results });
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

async function handleConfig(req, res) {
  if (req.method === "GET") {
    json(res, 200, { settings: await loadSettings() });
    return;
  }

  if (req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      json(res, 200, { settings: await saveSettings(body.settings || body) });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  json(res, 405, { error: "Method not allowed" });
}

async function handleTestNotification(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const result = await sendTelegram("Catch the Bus test", "Phone notifications are connected.");
    json(res, 200, { ok: true, result });
  } catch (error) {
    json(res, 502, { ok: false, error: error.message });
  }
}

async function handleTestCommute(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    json(res, 200, await evaluateCommute({ force: true, notify: true, bypassDuplicate: true }));
  } catch (error) {
    json(res, 502, { ok: false, error: error.message });
  }
}

async function handleBusArrival(req, res, url) {
  const stopCode = url.searchParams.get("stopCode")?.trim();

  if (!stopCode) {
    json(res, 400, { error: "Missing stopCode" });
    return;
  }

  try {
    json(res, 200, await fetchBusArrivalData(stopCode));
  } catch (error) {
    json(res, 502, { error: error.message });
  }
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/bus-arrival") {
    await handleBusArrival(req, res, url);
    return;
  }

  if (url.pathname === "/api/bus-stops") {
    await handleBusStopSearch(req, res, url);
    return;
  }

  if (url.pathname === "/api/config") {
    await handleConfig(req, res);
    return;
  }

  if (url.pathname === "/api/test-notification") {
    await handleTestNotification(req, res);
    return;
  }

  if (url.pathname === "/api/test-commute") {
    await handleTestCommute(req, res);
    return;
  }

  await serveStatic(req, res, url);
});

server.listen(port, () => {
  console.log(`Catch the Bus is running at http://localhost:${port}`);
  if (!ltaKey) {
    console.log("Using demo bus data. Set LTA_DATAMALL_KEY to use live Singapore LTA arrivals.");
  }
  if (!telegramToken || !telegramChatId) {
    console.log("Telegram notifications are disabled. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable phone alerts.");
  }
});

setInterval(runSchedulerTick, schedulerIntervalMs);
runSchedulerTick();
setInterval(pollTelegramUpdates, telegramPollMs);
pollTelegramUpdates();
