const WebSocket = require('ws');
const vesselCache = require('./vesselCache');
const sseManager = require('./sseManager');
const { getTrackedMMSIs } = require('./shipmentsStore');

const AIS_URL = 'wss://stream.aisstream.io/v0/stream';
const API_KEY = process.env.AISSTREAM_API_KEY;
const POSITION_TYPES = new Set([
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
]);

let ws = null;
let reconnectTimer = null;
let isConnected = false;
let messageCount = 0;
let positionCount = 0;
let lastMessageAt = null;
let lastError = null;

function buildSubscription() {
  const mmsis = getTrackedMMSIs();
  const subscription = {
    APIKey: API_KEY,
    BoundingBoxes: [[[-90, -180], [90, 180]]],
    FilterMessageTypes: [
      'PositionReport',
      'StandardClassBPositionReport',
      'ExtendedClassBPositionReport',
      'ShipStaticData',
      'StaticDataReport',
    ],
  };

  // AISstream supports up to 50 MMSIs per subscription.
  if (mmsis.length > 0) subscription.FiltersShipMMSI = mmsis.slice(0, 50);
  return subscription;
}

function connect() {
  if (!API_KEY || API_KEY === 'your_aisstream_api_key_here') {
    console.warn('[AIS] No API key set. Running in offline mode using shipment metadata only.');
    return;
  }

  console.log('[AIS] Connecting to AISstream.io...');
  ws = new WebSocket(AIS_URL);

  ws.on('open', () => {
    isConnected = true;
    lastError = null;
    clearTimeout(reconnectTimer);
    ws.send(JSON.stringify(buildSubscription()));
    console.log('[AIS] Connected and subscribed to tracked MMSIs.');
    sseManager.broadcast({ type: 'ais_status', connected: true });
  });

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.error) {
        lastError = String(message.error);
        console.error('[AIS] Provider error:', lastError);
        sseManager.broadcast({ type: 'ais_error', error: lastError });
        return;
      }

      messageCount++;
      lastMessageAt = new Date().toISOString();
      handleMessage(message);
    } catch (error) {
      lastError = error.message;
      console.error('[AIS] Parse error:', error.message);
    }
  });

  ws.on('close', (code) => {
    isConnected = false;
    console.warn(`[AIS] Disconnected (${code}). Reconnecting in 6s...`);
    sseManager.broadcast({ type: 'ais_status', connected: false });
    scheduleReconnect(6000);
  });

  ws.on('error', (error) => {
    lastError = error.message;
    console.error('[AIS] WebSocket error:', error.message);
    ws.terminate();
  });
}

function handleMessage(message) {
  const type = message.MessageType;
  const meta = message.Metadata || {};
  const mmsi = String(meta.MMSI || '');
  if (!mmsi) return;

  if (POSITION_TYPES.has(type)) {
    const report = message.Message?.[type] || {};
    const latitude = numberOrNull(meta.Latitude ?? meta.latitude ?? report.Latitude);
    const longitude = numberOrNull(meta.Longitude ?? meta.longitude ?? report.Longitude);
    if (!validCoordinates(latitude, longitude)) return;

    const heading = numberOrNull(report.TrueHeading);
    const update = {
      mmsi,
      name: cleanText(meta.ShipName || report.Name),
      latitude,
      longitude,
      sog: numberOrNull(report.Sog),
      cog: numberOrNull(report.Cog),
      true_heading: heading >= 0 && heading <= 359 ? heading : null,
      nav_status: report.NavigationalStatus,
      position_at: parseProviderTime(meta.time_utc || meta.TimeUTC) || new Date().toISOString(),
      source: 'AISstream',
      source_type: type,
    };

    vesselCache.update(mmsi, update);
    positionCount++;
    sseManager.broadcast({ type: 'position', data: update });
  }

  if (type === 'ShipStaticData') {
    const data = message.Message?.ShipStaticData || {};
    const update = {
      mmsi,
      name: cleanText(data.Name || meta.ShipName),
      imo: data.ImoNumber ? String(data.ImoNumber) : undefined,
      call_sign: cleanText(data.CallSign),
      ship_type: data.Type,
      destination: cleanText(data.Destination),
      eta_ais: data.Eta,
      draught: data.MaximumStaticDraught,
      dim_a: data.Dimension?.A,
      dim_b: data.Dimension?.B,
      source: 'AISstream',
    };
    vesselCache.update(mmsi, update);
    sseManager.broadcast({ type: 'static', data: update });
  }

  if (type === 'StaticDataReport') {
    const data = message.Message?.StaticDataReport || {};
    const reportA = data.ReportA || {};
    const reportB = data.ReportB || {};
    const update = {
      mmsi,
      name: cleanText(reportA.Name || meta.ShipName),
      call_sign: cleanText(reportB.CallSign),
      ship_type: reportB.ShipType,
      dim_a: reportB.Dimension?.A,
      dim_b: reportB.Dimension?.B,
      source: 'AISstream',
    };
    vesselCache.update(mmsi, update);
    sseManager.broadcast({ type: 'static', data: update });
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validCoordinates(latitude, longitude) {
  return latitude !== null && longitude !== null &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 &&
    !(latitude === 0 && longitude === 0);
}

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/@+$/g, '').trim() || undefined : undefined;
}

function parseProviderTime(value) {
  if (!value) return null;
  const parsed = new Date(String(value).replace(' UTC', ''));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function refreshSubscription() {
  if (!ws || !isConnected) return;
  ws.send(JSON.stringify(buildSubscription()));
}

function scheduleReconnect(ms) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, ms);
}

function status() {
  return {
    connected: isConnected,
    messageCount,
    positionCount,
    vesselCount: vesselCache.size(),
    apiKeySet: !!(API_KEY && API_KEY !== 'your_aisstream_api_key_here'),
    provider: 'AISstream',
    lastMessageAt,
    lastError,
  };
}

module.exports = { connect, status, refreshSubscription };
