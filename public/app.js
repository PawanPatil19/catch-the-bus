const storageKey = "catch-the-bus-settings";
const notifiedKey = "catch-the-bus-notified";
const pollEveryMs = 20_000;

const defaults = {
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

const form = document.querySelector("#settingsForm");
const arrivalList = document.querySelector("#arrivalList");
const nextAction = document.querySelector("#nextAction");
const pollStatus = document.querySelector("#pollStatus");
const dataSource = document.querySelector("#dataSource");
const lastUpdated = document.querySelector("#lastUpdated");
const testPhoneBtn = document.querySelector("#testPhoneBtn");
const testCommuteBtn = document.querySelector("#testCommuteBtn");
const locationBtn = document.querySelector("#locationBtn");
const refreshBtn = document.querySelector("#refreshBtn");
const autoPollToggle = document.querySelector("#autoPollToggle");
const locationStatus = document.querySelector("#locationStatus");
const currentLocation = document.querySelector("#currentLocation");
const saveHomeLocationBtn = document.querySelector("#saveHomeLocationBtn");
const saveOfficeLocationBtn = document.querySelector("#saveOfficeLocationBtn");
const manualHomeBtn = document.querySelector("#manualHomeBtn");
const manualOfficeBtn = document.querySelector("#manualOfficeBtn");

let settings = loadSettings();
let pollTimer = null;
let lastNotificationId = localStorage.getItem(notifiedKey) || "";
let stopSearchTimer = null;
let currentPlace = "unknown";
let currentPosition = null;

function loadSettings() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(storageKey)) };
  } catch {
    return { ...defaults };
  }
}

function saveSettings(next) {
  settings = { ...settings, ...next };
  localStorage.setItem(storageKey, JSON.stringify(settings));
  syncServerSettings(settings);
}

async function loadServerSettings() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return;
    const payload = await response.json();
    settings = { ...settings, ...payload.settings };
    localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    // The UI still works locally if the config API is unavailable.
  }
}

async function syncServerSettings(nextSettings) {
  try {
    await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: nextSettings })
    });
  } catch {
    // Keep the browser responsive; the next save can retry.
  }
}

function hydrateForm() {
  Object.entries(settings).forEach(([key, value]) => {
    if (key === "autoPoll") return;
    const field = form.elements[key];
    if (!field) return;
    if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = value;
  });
  autoPollToggle.checked = Boolean(settings.autoPoll);
  syncConnectionBlocks();
}

function parseServices(value) {
  return String(value)
    .split(",")
    .map((service) => service.trim())
    .filter(Boolean);
}

function checkboxValue(name) {
  return Boolean(form.elements[name]?.checked);
}

function numberValue(name) {
  const value = Number(form.elements[name]?.value);
  return Number.isFinite(value) ? value : 0;
}

function syncConnectionBlocks() {
  ["office", "home"].forEach((prefix) => {
    const checkbox = form.elements[`${prefix}SecondEnabled`];
    const block = checkbox?.closest(".commute-block")?.querySelector(".connection-block");
    if (block) block.classList.toggle("open", Boolean(checkbox?.checked));
  });
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "";
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

function distanceMeters(a, b) {
  const earthRadius = 6371000;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(h));
}

function getSavedPlace(name) {
  const lat = Number(settings[`${name}Lat`]);
  const lng = Number(settings[`${name}Lng`]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function detectPlace(position) {
  const radius = Number(settings.locationRadius || 300);
  const here = { lat: position.coords.latitude, lng: position.coords.longitude };
  const home = getSavedPlace("home");
  const office = getSavedPlace("office");
  const homeDistance = home ? distanceMeters(here, home) : Infinity;
  const officeDistance = office ? distanceMeters(here, office) : Infinity;

  if (homeDistance <= radius && homeDistance <= officeDistance) {
    return { place: "home", distance: homeDistance };
  }

  if (officeDistance <= radius) {
    return { place: "office", distance: officeDistance };
  }

  return { place: "away", distance: Math.min(homeDistance, officeDistance) };
}

function setLocationStatus(text) {
  locationStatus.textContent = text;
  pollStatus.textContent = text.includes("near") ? "Location aware" : pollStatus.textContent;
}

function setCurrentLocationReadout(position, detected) {
  if (!position) {
    currentLocation.textContent = "Current location: unavailable.";
    return;
  }

  const lat = position.coords.latitude.toFixed(6);
  const lng = position.coords.longitude.toFixed(6);
  const accuracy = formatDistance(position.coords.accuracy);
  const place = detected?.place === "away" ? "not near saved stops" : detected?.place || "unknown";
  currentLocation.textContent = `Current location: ${lat}, ${lng} (accuracy ${accuracy}). Detected: ${place}.`;
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Location is not supported in this browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 60_000,
      timeout: 12_000
    });
  });
}

async function updateCurrentPlace() {
  if (!settings.locationEnabled) {
    currentPlace = "unknown";
    setLocationStatus("");
    return currentPlace;
  }

  if (settings.manualPlace === "home" || settings.manualPlace === "office") {
    currentPlace = settings.manualPlace;
    setCurrentLocationReadout(currentPosition, { place: currentPlace });
    setLocationStatus(
      currentPlace === "home"
        ? "Manual mode: treating you as home. Watching the office trip."
        : "Manual mode: treating you as office. Watching the home trip."
    );
    return currentPlace;
  }

  try {
    currentPosition = await getCurrentPosition();
    const detected = detectPlace(currentPosition);
    currentPlace = detected.place;
    setCurrentLocationReadout(currentPosition, detected);

    if (currentPlace === "home") {
      setLocationStatus(`You look near home (${formatDistance(detected.distance)}). Watching the office trip.`);
    } else if (currentPlace === "office") {
      setLocationStatus(`You look near office (${formatDistance(detected.distance)}). Watching the home trip.`);
    } else {
      setLocationStatus("You are not near saved home or office. Commute watching is idle.");
    }
  } catch (error) {
    currentPlace = "unknown";
    setCurrentLocationReadout(null);
    setLocationStatus(`Location unavailable: ${error.message}. Use I'm at home or I'm at office.`);
  }

  return currentPlace;
}

function tripsForCurrentPlace() {
  const trips = getTrips();
  if (!settings.locationEnabled) return trips;
  if (currentPlace === "home") return trips.filter((trip) => trip.id === "office");
  if (currentPlace === "office") return trips.filter((trip) => trip.id === "home");
  return [];
}

function debounceStopSearch(callback) {
  window.clearTimeout(stopSearchTimer);
  stopSearchTimer = window.setTimeout(callback, 250);
}

function closeStopResults() {
  document.querySelectorAll(".stop-results").forEach((results) => {
    results.classList.remove("open");
    results.replaceChildren();
  });
}

function applyStopLocation(targetName, stop) {
  if (targetName === "officeStop") {
    form.elements.homeLat.value = stop.latitude;
    form.elements.homeLng.value = stop.longitude;
    saveSettings({ homeLat: stop.latitude, homeLng: stop.longitude });
  }

  if (targetName === "homeStop") {
    form.elements.officeLat.value = stop.latitude;
    form.elements.officeLng.value = stop.longitude;
    saveSettings({ officeLat: stop.latitude, officeLng: stop.longitude });
  }
}

function makeStopOption(stop, targetInput, searchInput, results) {
  const option = document.createElement("button");
  const title = document.createElement("strong");
  const detail = document.createElement("span");

  option.type = "button";
  option.className = "stop-option";
  option.setAttribute("role", "option");
  title.textContent = `${stop.description} (${stop.code})`;
  detail.textContent = stop.roadName;
  option.append(title, detail);

  option.addEventListener("click", () => {
    targetInput.value = stop.code;
    searchInput.value = `${stop.description}, ${stop.roadName}`;
    applyStopLocation(searchInput.dataset.targetStop, stop);
    results.classList.remove("open");
    results.replaceChildren();
  });

  return option;
}

async function searchBusStops(query, targetInput, searchInput, results) {
  if (query.trim().length < 2) {
    closeStopResults();
    return;
  }

  results.classList.add("open");
  results.replaceChildren();

  const loading = document.createElement("div");
  loading.className = "empty";
  loading.textContent = "Searching stops...";
  results.append(loading);

  try {
    const response = await fetch(`/api/bus-stops?query=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error("Could not search bus stops");
    const payload = await response.json();

    results.replaceChildren();

    if (!payload.results.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No bus stops found for that search.";
      results.append(empty);
      return;
    }

    payload.results.forEach((stop) => {
      results.append(makeStopOption(stop, targetInput, searchInput, results));
    });
  } catch (error) {
    results.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = error.message;
    results.append(empty);
  }
}

async function findStopByCode(stopCode) {
  if (!stopCode) throw new Error("Enter a bus stop code first.");
  const response = await fetch(`/api/bus-stops?query=${encodeURIComponent(stopCode)}`);
  if (!response.ok) throw new Error("Could not look up that bus stop.");
  const payload = await response.json();
  const stop = payload.results.find((result) => result.code === stopCode) || payload.results[0];
  if (!stop) throw new Error("No bus stop found for that code.");
  return stop;
}

function initStopSearch() {
  document.querySelectorAll("[data-stop-search]").forEach((searchInput) => {
    const targetInput = form.elements[searchInput.dataset.targetStop];
    const results = document.querySelector(`[data-stop-results="${searchInput.dataset.stopSearch}"]`);

    searchInput.addEventListener("input", () => {
      debounceStopSearch(() => searchBusStops(searchInput.value, targetInput, searchInput, results));
    });

    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeStopResults();
    });
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".stop-search")) closeStopResults();
  });
}

function minutesSinceMidnight(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value || "00:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function getTrips() {
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

function activeTrips() {
  const now = minutesSinceMidnight();
  return tripsForCurrentPlace().filter((trip) => {
    const leave = timeToMinutes(trip.leaveAt);
    return now >= leave - trip.windowMinutes && now <= leave + trip.windowMinutes;
  });
}

function chooseTrips(force = false) {
  const active = activeTrips();
  if (force) return tripsForCurrentPlace();
  return active;
}

function formatTime(iso) {
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
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
      if (waitMinutes >= 0) {
        options.push({ service, arrival, readyAt, waitMinutes });
      }
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

function notificationAllowed() {
  return "Notification" in window && Notification.permission === "granted";
}

function maybeNotify(best) {
  if (!notificationAllowed() || !best) return;
  if (!["run", "hurry", "go", "connect"].includes(best.action.level)) return;

  const bucket = Math.floor(Date.now() / (5 * 60_000));
  const id = `${currentPlace}:${best.trip.id}:${best.service.serviceNo}:${best.next.minutes}:${best.action.level}:${bucket}`;
  if (id === lastNotificationId) return;

  lastNotificationId = id;
  localStorage.setItem(notifiedKey, id);

  new Notification(best.action.title, {
    body: `${currentPlace === "unknown" ? "" : `Near ${currentPlace}. `}${best.service.serviceNo} from stop ${best.trip.stopCode}. ${best.action.message}`,
    tag: `${best.trip.id}-${best.service.serviceNo}`,
    renotify: true
  });
}

async function fetchTrip(trip) {
  const firstResponse = await fetch(`/api/bus-arrival?stopCode=${encodeURIComponent(trip.stopCode)}`);
  if (!firstResponse.ok) throw new Error(`Could not fetch ${trip.label} stop ${trip.stopCode}`);
  const firstPayload = await firstResponse.json();

  let secondPayload = null;

  if (isSecondLegReady(trip)) {
    const secondResponse = await fetch(`/api/bus-arrival?stopCode=${encodeURIComponent(trip.secondLeg.stopCode)}`);
    if (!secondResponse.ok) throw new Error(`Could not fetch ${trip.label} transfer stop ${trip.secondLeg.stopCode}`);
    secondPayload = await secondResponse.json();
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

function renderArrivals(results) {
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

  const catchableRows = rows.filter(canCatch);

  if (rows.length === 0) {
    arrivalList.innerHTML = `<div class="empty">No matching buses found yet. Check the stop code and service numbers, then refresh.</div>`;
    nextAction.textContent = "No matching bus";
    return null;
  }

  if (catchableRows.length === 0) {
    const first = rows[0];
    arrivalList.innerHTML = `<div class="empty">No catchable bus based on a ${first.trip.walkMinutes} min walk. Earliest ${first.service.serviceNo} arrives in ${first.next.minutes} min.</div>`;
    nextAction.textContent = "No catchable bus";
    return null;
  }

  arrivalList.innerHTML = catchableRows
    .map(({ trip, service, next, action, connection }) => {
      const arrivalPills = service.arrivals
        .map((arrival) => `<span class="pill">${arrival.minutes}m</span>`)
        .join("");
      const busLabel =
        connection?.service
          ? `${service.serviceNo}<span>to ${connection.service.serviceNo}</span>`
          : `${service.serviceNo}`;
      const connectionPills =
        connection?.service?.arrivals
          .map((arrival) => {
            const wait = minutesBetween(connection.readyAt, new Date(arrival.estimatedArrival));
            return `<span class="pill">${wait >= 0 ? `+${wait}m` : "miss"}</span>`;
          })
          .join("") || arrivalPills;
      const detail = connection?.service
        ? `${action.message} First bus at ${formatTime(next.estimatedArrival)}; second bus at ${formatTime(connection.arrival.estimatedArrival)}.`
        : `${action.message} Next at ${formatTime(next.estimatedArrival)}.`;

      return `
        <article class="arrival-card ${action.level}">
          <div class="bus-no">${busLabel}</div>
          <div>
            <strong>${action.title} for ${trip.label.toLowerCase()}</strong>
            <p>${detail}</p>
          </div>
          <div class="minutes" aria-label="Upcoming arrival minutes">${connectionPills}</div>
        </article>
      `;
    })
    .join("");

  const best = catchableRows[0];
  nextAction.textContent = `${best.action.title}: ${best.service.serviceNo} in ${best.next.minutes} min`;
  return best;
}

async function refresh({ force = false, notify = false } = {}) {
  await updateCurrentPlace();
  const trips = chooseTrips(force).filter((trip) => trip.stopCode && trip.services.length > 0);
  if (trips.length === 0) {
    const emptyMessage =
      settings.locationEnabled && currentPlace === "away"
        ? "Not near saved home or office, so commute notifications are idle."
        : "Outside your leave window. Use Refresh now to check manually.";
    arrivalList.innerHTML = `<div class="empty">${emptyMessage}</div>`;
    dataSource.textContent = "Live arrivals will refresh when a commute is active.";
    pollStatus.textContent = currentPlace === "away" ? "Away" : "Outside window";
    return;
  }

  pollStatus.textContent = activeTrips().length > 0 ? "Watching" : "Outside window";

  try {
    const results = await Promise.all(trips.map(fetchTrip));
    const source = results.find(Boolean)?.source;
    dataSource.textContent =
      source === "lta"
        ? "Live arrivals from Singapore LTA DataMall."
        : "Demo arrivals are active until an LTA DataMall key is configured.";
    lastUpdated.textContent = `Updated ${new Intl.DateTimeFormat([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date())}`;

    const best = renderArrivals(results);
    if (notify && best) maybeNotify(best);
  } catch (error) {
    arrivalList.innerHTML = `<div class="empty">${error.message}</div>`;
    pollStatus.textContent = "Fetch failed";
  }
}

function schedulePolling() {
  window.clearInterval(pollTimer);

  if (!settings.autoPoll) {
    pollStatus.textContent = "Paused";
    return;
  }

  pollTimer = window.setInterval(() => {
    refresh({ notify: true });
  }, pollEveryMs);

  refresh({ notify: true });
}

testPhoneBtn.addEventListener("click", async () => {
  try {
    testPhoneBtn.disabled = true;
    testPhoneBtn.textContent = "Sending...";
    const response = await fetch("/api/test-notification", { method: "POST" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Test failed");
    dataSource.textContent = "Phone test notification sent.";
  } catch (error) {
    dataSource.textContent = `Phone test failed: ${error.message}`;
  } finally {
    testPhoneBtn.disabled = false;
    testPhoneBtn.textContent = "Test phone alert";
  }
});

testCommuteBtn.addEventListener("click", async () => {
  try {
    testCommuteBtn.disabled = true;
    testCommuteBtn.textContent = "Checking...";
    const response = await fetch("/api/test-commute", { method: "POST" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Commute test failed");
    dataSource.textContent = payload.notified
      ? `Commute alert sent: ${payload.best.title} for ${payload.best.serviceNo}.`
      : `No commute alert sent: ${payload.reason || "no matching bus"}.`;
  } catch (error) {
    dataSource.textContent = `Commute test failed: ${error.message}`;
  } finally {
    testCommuteBtn.disabled = false;
    testCommuteBtn.textContent = "Test commute alert";
  }
});

locationBtn.addEventListener("click", async () => {
  form.elements.locationEnabled.checked = true;
  saveSettings({ locationEnabled: true });
  await refresh({ force: true });
});

refreshBtn.addEventListener("click", () => refresh({ force: true, notify: true }));

autoPollToggle.addEventListener("change", () => {
  saveSettings({ autoPoll: autoPollToggle.checked });
  schedulePolling();
});

form.elements.locationEnabled.addEventListener("change", () => {
  saveSettings({ locationEnabled: checkboxValue("locationEnabled") });
  refresh({ force: true });
  schedulePolling();
});

async function saveBusStopLocation(place) {
  try {
    const stopField = place === "home" ? "officeStop" : "homeStop";
    const stop = await findStopByCode(form.elements[stopField].value.trim());
    const lat = Number(stop.latitude).toFixed(6);
    const lng = Number(stop.longitude).toFixed(6);
    form.elements[`${place}Lat`].value = lat;
    form.elements[`${place}Lng`].value = lng;
    form.elements.locationEnabled.checked = true;
    saveSettings({
      [`${place}Lat`]: lat,
      [`${place}Lng`]: lng,
      locationEnabled: true,
      locationRadius: numberValue("locationRadius") || settings.locationRadius
    });
    setLocationStatus(
      `${place === "home" ? "Home" : "Office"} anchor set from ${stop.description} (${stop.code}). Use I'm at ${place} if browser location is unavailable.`
    );
  } catch (error) {
    setLocationStatus(`Could not set ${place}: ${error.message}`);
  }
}

saveHomeLocationBtn.addEventListener("click", () => saveBusStopLocation("home"));
saveOfficeLocationBtn.addEventListener("click", () => saveBusStopLocation("office"));

function setManualPlace(place) {
  form.elements.locationEnabled.checked = true;
  saveSettings({ locationEnabled: true, manualPlace: place });
  refresh({ force: true, notify: true });
  schedulePolling();
}

manualHomeBtn.addEventListener("click", () => setManualPlace("home"));
manualOfficeBtn.addEventListener("click", () => setManualPlace("office"));

form.querySelectorAll('input[name$="SecondEnabled"]').forEach((checkbox) => {
  checkbox.addEventListener("change", syncConnectionBlocks);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  saveSettings({
    officeStop: formData.get("officeStop"),
    officeServices: formData.get("officeServices"),
    officeLeave: formData.get("officeLeave"),
    officeWalk: Number(formData.get("officeWalk")),
    officeWindow: Number(formData.get("officeWindow")),
    officeSecondEnabled: checkboxValue("officeSecondEnabled"),
    officeSecondStop: formData.get("officeSecondStop"),
    officeSecondServices: formData.get("officeSecondServices"),
    officeRideToSecond: Number(formData.get("officeRideToSecond")),
    officeTransferWalk: Number(formData.get("officeTransferWalk")),
    homeStop: formData.get("homeStop"),
    homeServices: formData.get("homeServices"),
    homeLeave: formData.get("homeLeave"),
    homeWalk: Number(formData.get("homeWalk")),
    homeWindow: Number(formData.get("homeWindow")),
    homeSecondEnabled: checkboxValue("homeSecondEnabled"),
    homeSecondStop: formData.get("homeSecondStop"),
    homeSecondServices: formData.get("homeSecondServices"),
    homeRideToSecond: Number(formData.get("homeRideToSecond")),
    homeTransferWalk: Number(formData.get("homeTransferWalk")),
    locationEnabled: checkboxValue("locationEnabled"),
    homeLat: formData.get("homeLat"),
    homeLng: formData.get("homeLng"),
    officeLat: formData.get("officeLat"),
    officeLng: formData.get("officeLng"),
    locationRadius: Number(formData.get("locationRadius")),
    manualPlace: settings.manualPlace
  });
  refresh({ force: true, notify: true });
  schedulePolling();
});

async function init() {
  await loadServerSettings();
  hydrateForm();
  initStopSearch();
  refresh({ force: true });
  schedulePolling();
}

init();
