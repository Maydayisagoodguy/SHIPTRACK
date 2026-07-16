const WebSocket = require('ws');
const vesselCache = require('./vesselCache');
const sseManager  = require('./sseManager');
const { getTrackedMMSIs } = require('./shipmentsStore');

const AIS_URL = 'wss://stream.aisstream.io/v0/stream';
const API_KEY  = process.env.AISSTREAM_API_KEY;

let ws              = null;
let reconnectTimer  = null;
let isConnected     = false;
let messageCount    = 0;

function buildSubscription() {
  const mmsis = getTrackedMMSIs();
  const sub = {
    Apikey: API_KEY,
    // Global bounding box — AISstream filters on their side too
    BoundingBoxes: [[[-90, -180], [90, 180]]],
    FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
  };
  // Filter to only tracked vessels (reduces data volume significantly)
  if (mmsis.length > 0) sub.FilterMMSI = mmsis;
  return sub;
}

function connect() {
  if (!API_KEY || API_KEY === 'your_aisstream_api_key_here') {
    console.warn('[AIS] No API key set. Running in OFFLINE mode — using shipments.json metadata only.');
    console.warn('[AIS] Get your free key at https://aisstream.io then add it to backend/.env');
    return;
  }

  console.log('[AIS] Connecting to AISstream.io...');
  ws = new WebSocket(AIS_URL);

  ws.on('open', () => {
    isConnected = true;
    clearTimeout(reconnectTimer);
    console.log('[AIS] Connected. Sending subscription...');
    ws.send(JSON.stringify(buildSubscription()));
    sseManager.broadcast({ type: 'ais_status', connected: true });
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      messageCount++;
      handleMessage(msg);
    } catch (e) {
      console.error('[AIS] Parse error:', e.message);
    }
  });

  ws.on('close', (code) => {
    isConnected = false;
    console.warn(`[AIS] Disconnected (${code}). Reconnecting in 6s...`);
    sseManager.broadcast({ type: 'ais_status', connected: false });
    scheduleReconnect(6000);
  });

  ws.on('error', (err) => {
    console.error('[AIS] WebSocket error:', err.message);
    ws.terminate();
  });
}

function handleMessage(msg) {
  const type = msg.MessageType;
  const meta = msg.Metadata || {};
  const mmsi = String(meta.MMSI || '');
  if (!mmsi) return;

  if (type === 'PositionReport') {
    const r = msg.Message?.PositionReport || {};
    const update = {
      mmsi,
      latitude:      meta.Latitude  ?? r.Latitude,
      longitude:     meta.Longitude ?? r.Longitude,
      sog:           r.Sog,
      cog:           r.Cog,
      true_heading:  r.TrueHeading,
      nav_status:    r.NavigationalStatus,
    };
    vesselCache.update(mmsi, update);
    sseManager.broadcast({ type: 'position', data: update });
  }

  if (type === 'ShipStaticData') {
    const s = msg.Message?.ShipStaticData || {};
    const update = {
      mmsi,
      name:        s.Name?.trim(),
      imo:         s.ImoNumber ? String(s.ImoNumber) : undefined,
      call_sign:   s.CallSign?.trim(),
      ship_type:   s.Type,
      destination: s.Destination?.trim(),
      eta_ais:     s.Eta,
      draught:     s.MaximumStaticDraught,
      dim_a:       s.Dimension?.A,
      dim_b:       s.Dimension?.B,
    };
    vesselCache.update(mmsi, update);
    sseManager.broadcast({ type: 'static', data: update });
  }
}

// Call this when a new shipment is added to refresh the MMSI subscription
function refreshSubscription() {
  if (!ws || !isConnected) return;
  console.log('[AIS] Refreshing MMSI subscription...');
  ws.send(JSON.stringify(buildSubscription()));
}

function scheduleReconnect(ms) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, ms);
}

function status() {
  return {
    connected:    isConnected,
    messageCount,
    vesselCount:  vesselCache.size(),
    apiKeySet:    !!(API_KEY && API_KEY !== 'your_aisstream_api_key_here'),
  };
}

module.exports = { connect, status, refreshSubscription };
