const vesselCache = require('../vesselCache');
const sseManager = require('../sseManager');
const { getTrackedMMSIs } = require('../shipmentsStore');

const API_URL = process.env.SPIRE_API_URL || 'https://api.spire.com/graphql';
const TOKEN = process.env.SPIRE_API_TOKEN;
const POLL_MS = Math.max(60000, parseInt(process.env.SPIRE_POLL_MS || '300000', 10));

let timer = null;
let polling = false;
let lastPollAt = null;
let lastSuccessAt = null;
let lastError = null;
let positionCount = 0;

function configured() {
  return Boolean(TOKEN && TOKEN !== 'your_spire_trial_token_here');
}

function buildQuery() {
  return `query TrackedVessels($mmsi: [MMSI!]!) {
    vessels(first: 100, mmsi: $mmsi) {
      nodes {
        staticData { name imo mmsi callsign shipType dimensions { width length } }
        lastPositionUpdate {
          accuracy collectionType course heading latitude longitude
          navigationalStatus speed timestamp updateTimestamp
        }
        currentVoyage {
          destination draught eta timestamp updateTimestamp
          matchedPort { matchScore port { unlocode name centerPoint { latitude longitude } } }
        }
      }
    }
  }`;
}

async function poll() {
  if (!configured() || polling) return;
  const mmsis = getTrackedMMSIs().map(String).slice(0, 100);
  if (!mmsis.length) return;

  polling = true;
  lastPollAt = new Date().toISOString();
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: buildQuery(),
        variables: { mmsi: mmsis.map(Number) },
      }),
      signal: AbortSignal.timeout(30000),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.errors?.length) {
      throw new Error(payload.errors?.[0]?.message || `Spire HTTP ${response.status}`);
    }

    for (const node of payload.data?.vessels?.nodes || []) normalizeAndStore(node);
    lastSuccessAt = new Date().toISOString();
    lastError = null;
    sseManager.broadcast({ type: 'provider_status', provider: 'Spire', connected: true });
  } catch (error) {
    lastError = error.message;
    console.error('[Spire] Poll failed:', error.message);
    sseManager.broadcast({ type: 'provider_error', provider: 'Spire', error: error.message });
  } finally {
    polling = false;
  }
}

function normalizeAndStore(node) {
  const staticData = node.staticData || {};
  const position = node.lastPositionUpdate || {};
  const voyage = node.currentVoyage || {};
  const mmsi = String(staticData.mmsi || '');
  const latitude = finite(position.latitude);
  const longitude = finite(position.longitude);
  if (!/^\d{9}$/.test(mmsi) || latitude === null || longitude === null) return;

  const matchedPort = voyage.matchedPort?.port;
  const update = {
    mmsi,
    name: clean(staticData.name),
    imo: staticData.imo ? String(staticData.imo) : undefined,
    call_sign: clean(staticData.callsign),
    ship_type: staticData.shipType,
    latitude,
    longitude,
    sog: finite(position.speed),
    cog: finite(position.course),
    true_heading: validHeading(position.heading),
    nav_status: position.navigationalStatus,
    position_at: validDate(position.timestamp || position.updateTimestamp),
    destination: clean(voyage.destination),
    eta_provider: validDate(voyage.eta),
    draught: finite(voyage.draught),
    matched_port: matchedPort ? {
      name: matchedPort.name,
      unlocode: matchedPort.unlocode,
      latitude: matchedPort.centerPoint?.latitude,
      longitude: matchedPort.centerPoint?.longitude,
      confidence: voyage.matchedPort?.matchScore,
    } : undefined,
    source: 'Spire',
    source_type: position.collectionType || 'AIS',
    accuracy: position.accuracy,
  };

  vesselCache.update(mmsi, update);
  positionCount++;
  sseManager.broadcast({ type: 'position', data: update });
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validHeading(value) {
  const number = finite(value);
  return number !== null && number >= 0 && number <= 359 ? number : null;
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function clean(value) {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function start() {
  if (!configured()) {
    console.log('[Spire] Trial token not configured; provider disabled.');
    return;
  }
  console.log(`[Spire] Polling tracked vessels every ${Math.round(POLL_MS / 1000)}s.`);
  poll();
  timer = setInterval(poll, POLL_MS);
}

function refresh() {
  if (configured()) poll();
}

function status() {
  return {
    provider: 'Spire',
    configured: configured(),
    connected: configured() && Boolean(lastSuccessAt) && !lastError,
    polling,
    pollIntervalMs: POLL_MS,
    lastPollAt,
    lastSuccessAt,
    lastError,
    positionCount,
  };
}

module.exports = { start, refresh, status, poll };
