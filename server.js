import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function berlinDate(offsetDays = 0) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return formatter.format(date);
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeEnergyCharts(payload) {
  const timestamps = payload.unix_seconds || payload.time || payload.xAxisValues || [];
  const series = payload.production_types || payload.data || [];
  const nowSeconds = Date.now() / 1000;

  let index = -1;
  for (let i = timestamps.length - 1; i >= 0; i -= 1) {
    const ts = Number(timestamps[i]);
    if (Number.isFinite(ts) && ts <= nowSeconds + 900) {
      const hasValue = series.some((entry) => parseNumber(entry.data?.[i]) !== null);
      if (hasValue) {
        index = i;
        break;
      }
    }
  }

  if (index < 0) {
    throw new Error("Energy-Charts lieferte keine aktuellen Erzeugungswerte.");
  }

  const excludedNames = /cross border|electricity trading|load|residual load/i;
  const sourceNames = {
    "Wind onshore": "Wind an Land",
    "Wind offshore": "Wind auf See",
    Solar: "Solar",
    Biomass: "Biomasse",
    "Hydro Run-of-River": "Laufwasser",
    "Hydro pumped storage": "Pumpspeicher",
    "Hydro water reservoir": "Speicherwasser",
    Geothermal: "Geothermie",
    Waste: "Abfall",
    "Fossil brown coal / lignite": "Braunkohle",
    "Fossil hard coal": "Steinkohle",
    "Fossil gas": "Erdgas",
    "Fossil oil": "Öl",
    "Fossil coal-derived gas": "Kokereigas",
    Others: "Sonstige"
  };

  const sources = series
    .map((entry) => ({
      rawName: entry.name || entry.label || "Unbekannt",
      name: sourceNames[entry.name || entry.label] || entry.name || entry.label || "Unbekannt",
      value: parseNumber(entry.data?.[index]) || 0,
      color: entry.color || entry.fillColor || null
    }))
    .filter((entry) => !excludedNames.test(entry.rawName))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = sources.reduce((sum, entry) => sum + entry.value, 0);
  const renewableNames = /solar|wind|hydro|biomass|renewable|laufwasser|speicherwasser|wasserkraft|bio|geotherm/i;
  const renewable = sources
    .filter((entry) => renewableNames.test(entry.rawName) || renewableNames.test(entry.name))
    .reduce((sum, entry) => sum + entry.value, 0);

  return {
    timestamp: new Date(Number(timestamps[index]) * 1000).toISOString(),
    totalMw: total,
    renewableMw: renewable,
    sources,
    source: "Fraunhofer ISE Energy-Charts"
  };
}

function findCurrentIndex(timestamps, entries) {
  const nowSeconds = Date.now() / 1000;

  for (let i = timestamps.length - 1; i >= 0; i -= 1) {
    const ts = Number(timestamps[i]);
    if (Number.isFinite(ts) && ts <= nowSeconds + 900) {
      const hasValue = entries.some((entry) => parseNumber(entry.data?.[i] ?? entry.values?.[i]) !== null);
      if (hasValue) return i;
    }
  }

  return -1;
}

function findLatestValueIndex(timestamps, entry) {
  const nowSeconds = Date.now() / 1000;

  for (let i = timestamps.length - 1; i >= 0; i -= 1) {
    const ts = Number(timestamps[i]);
    if (Number.isFinite(ts) && ts <= nowSeconds + 900 && parseNumber(entry?.data?.[i]) !== null) {
      return i;
    }
  }

  return -1;
}

async function fetchGeneration() {
  const params = new URLSearchParams({
    country: "de",
    start: berlinDate(-1),
    end: berlinDate()
  });
  const response = await fetch(`https://api.energy-charts.info/public_power?${params}`, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Energy-Charts antwortete mit Status ${response.status}.`);
  }

  return normalizeEnergyCharts(await response.json());
}

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`${label} antwortete mit Status ${response.status}.`);
  }

  return response.json();
}

async function fetchMarketMetrics() {
  const powerParams = new URLSearchParams({
    country: "de",
    start: berlinDate(-1),
    end: berlinDate()
  });
  const priceParams = new URLSearchParams({
    bzn: "DE-LU",
    start: berlinDate(),
    end: berlinDate()
  });

  const [power, price] = await Promise.all([
    fetchJson(`https://api.energy-charts.info/total_power?${powerParams}`, "Energy-Charts Lastdaten"),
    fetchJson(`https://api.energy-charts.info/price?${priceParams}`, "Energy-Charts Preisdaten")
  ]);

  const timestamps = power.unix_seconds || [];
  const series = power.production_types || [];
  const loadEntry = series.find((entry) => entry.name === "Load (incl. self-consumption)");
  const index = findLatestValueIndex(timestamps, loadEntry);

  if (index < 0) {
    throw new Error("Energy-Charts lieferte keine aktuellen Lastdaten.");
  }

  const valueFor = (name) =>
    parseNumber(series.find((entry) => entry.name === name)?.data?.[index]);
  const priceTimestamps = price.unix_seconds || [];
  const priceEntries = [{ data: price.price || [] }];
  const priceIndex = findCurrentIndex(priceTimestamps, priceEntries);
  const priceValue = priceIndex >= 0 ? parseNumber(price.price?.[priceIndex]) : null;

  const exchangeMw = valueFor("Cross border electricity trading");

  return {
    timestamp: new Date(Number(timestamps[index]) * 1000).toISOString(),
    loadMw: valueFor("Load (incl. self-consumption)"),
    residualLoadMw: valueFor("Residual load"),
    renewableLoadShare: valueFor("Renewable share of load"),
    exchangeMw,
    exchangeLabel: exchangeMw === null ? "nicht verfügbar" : exchangeMw >= 0 ? "Exportsaldo" : "Importsaldo",
    priceEurMwh: priceValue,
    priceTimestamp: priceIndex >= 0 ? new Date(Number(priceTimestamps[priceIndex]) * 1000).toISOString() : null,
    source: "Fraunhofer ISE Energy-Charts"
  };
}

async function fetchFrequency() {
  const response = await fetch("https://dat.netzfrequenzmessung.de:9080/frequenz.xml", {
    headers: { accept: "application/xml,text/xml" }
  });

  if (!response.ok) {
    throw new Error(`Netzfrequenzmessung antwortete mit Status ${response.status}.`);
  }

  const xml = await response.text();
  const frequency = parseNumber(xml.match(/<f>([^<]+)<\/f>/)?.[1]);
  const timestamp = xml.match(/<z>([^<]+)<\/z>/)?.[1];

  if (frequency === null || !timestamp) {
    throw new Error("Die Netzfrequenz-Antwort konnte nicht gelesen werden.");
  }

  return {
    frequency,
    deviationMhZ: Math.round((frequency - 50) * 1000),
    timestamp,
    source: "netzfrequenzmessung.de"
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = normalize(join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mime[extname(filePath)] || "application/octet-stream"
    });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/generation")) {
      json(res, 200, await fetchGeneration());
      return;
    }

    if (req.url?.startsWith("/api/frequency")) {
      json(res, 200, await fetchFrequency());
      return;
    }

    if (req.url?.startsWith("/api/metrics")) {
      json(res, 200, await fetchMarketMetrics());
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    json(res, 502, {
      error: error instanceof Error ? error.message : "Unbekannter Fehler"
    });
  }
});

server.listen(port, host, () => {
  console.log(`Stromblick laeuft auf http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
});
