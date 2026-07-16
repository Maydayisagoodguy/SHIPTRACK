# Real-Time Ship Tracking Module — HUMANITY ERP
**Build Guide for Claude Code**

---

## Table of Contents

1. [What We Are Building](#1-what-we-are-building)
2. [How It All Works — The Big Picture](#2-how-it-all-works--the-big-picture)
3. [Tech Stack](#3-tech-stack)
4. [Understanding AIS Data](#4-understanding-ais-data)
5. [Project Structure](#5-project-structure)
6. [Environment Variables](#6-environment-variables)
7. [Supabase Setup — Database Schema](#7-supabase-setup--database-schema)
8. [Backend — Node.js/Express Server](#8-backend--nodejs-express-server)
   - 8a. AISstream WebSocket Client
   - 8b. Supabase Upsert Layer
   - 8c. REST Endpoints for Frontend
   - 8d. Server-Sent Events (SSE) for Live Push
9. [Frontend — Map Page](#9-frontend--map-page)
   - 9a. Mapbox GL JS Setup
   - 9b. GeoJSON Layer Architecture
   - 9c. SSE Connection to Backend
   - 9d. Ship Icons, Colors, Popups
   - 9e. Filters and Controls Panel
10. [Data Flow — Step by Step](#10-data-flow--step-by-step)
11. [Reconnection and Resilience](#11-reconnection-and-resilience)
12. [Performance Considerations](#12-performance-considerations)
13. [Deploying on Render](#13-deploying-on-render)
14. [ERP Integration Points](#14-erp-integration-points)
15. [Full File Listing](#15-full-file-listing)

---

## 1. What We Are Building

A real-time maritime ship tracking dashboard embedded inside HUMANITY ERP. It shows:

- Live ship positions on an interactive map, updating every few seconds
- Each ship rendered as a directional arrow/icon that rotates with heading
- Ships color-coded by vessel type (cargo, tanker, passenger, etc.)
- Click any ship → popup with vessel name, MMSI, speed, destination, ETA
- Filter panel: filter by vessel type, speed range, destination port
- Stats bar: total ships tracked, average speed, vessel type breakdown
- The map persists last-known positions from Supabase even before the live stream catches up

This module is a standalone page inside your ERP, accessible at a route like `/erp/tracking`.

---

## 2. How It All Works — The Big Picture

```
WORLD OCEAN
    │
    │  Ships broadcast AIS signals every 2–10 seconds
    ▼
AISstream.io
    │  (Free WebSocket API — aggregates global AIS stations)
    │  wss://stream.aisstream.io/v0/stream
    ▼
YOUR NODE.JS SERVER (on Render)
    │
    ├─── Receives raw AIS JSON messages via WebSocket
    │
    ├─── Normalizes & filters the data
    │
    ├─── Upserts vessel positions into Supabase (PostgreSQL)
    │    (so positions survive server restarts and load instantly)
    │
    └─── Pushes updates to connected browser clients via SSE
         (Server-Sent Events — no WebSocket needed on frontend)
             │
             ▼
    BROWSER (Mapbox GL JS map)
         │
         ├─── On first load: fetches last-known positions from Supabase via REST
         │    (map fills immediately, no waiting for live stream)
         │
         └─── SSE stream updates ship positions in real-time
              Mapbox GeoJSON layer re-renders on GPU — smooth, no lag
```

**Why a Node.js proxy instead of connecting AISstream directly from the browser?**

- AISstream uses HTTP/2 for its WebSocket upgrade, which browsers handle inconsistently
- Your API key must never be exposed in frontend code
- The proxy lets you filter, normalize, and rate-limit data before it hits the browser
- Supabase caching only works server-side

---

## 3. Tech Stack

| Layer | Technology | Why |
|---|---|---|
| AIS Data Source | AISstream.io | Free, real-time WebSocket, excellent Node.js support |
| Backend | Node.js + Express | Your existing ERP stack |
| AIS WebSocket client | `ws` npm package | Lightweight, battle-tested |
| Database / Cache | Supabase (PostgreSQL) | Your existing ERP database |
| Frontend → Backend live link | Server-Sent Events (SSE) | Simpler than WebSocket, works through proxies/Nginx |
| Map rendering | Mapbox GL JS v3 | GPU-accelerated, handles 100K+ markers smoothly |
| Map tiles | Mapbox (free 50K loads/month) | Professional-looking dark nautical style available |

---

## 4. Understanding AIS Data

AIS (Automatic Identification System) is mandated by the IMO for all commercial vessels over 300 gross tonnage. Ships broadcast their data every 2–10 seconds via VHF radio. Coastal AIS stations pick this up and forward it to services like AISstream.

### Key Fields You Will Use

| Field | What it is | Example |
|---|---|---|
| `MMSI` | 9-digit unique vessel ID | `211331640` |
| `IMO` | International Maritime Organization number | `9548480` |
| `Name` | Vessel name | `"NORDIC POLLUX"` |
| `Latitude` | Position (decimal degrees) | `53.5432` |
| `Longitude` | Position (decimal degrees) | `9.9846` |
| `SOG` (Speed Over Ground) | Speed in knots | `12.4` |
| `COG` (Course Over Ground) | Direction of movement (0–360°) | `245.3` |
| `TrueHeading` | Where the bow points (0–360°) | `244` |
| `NavigationalStatus` | 0=underway engine, 1=anchored, 5=moored, etc. | `0` |
| `ShipType` | Numeric vessel type (70=cargo, 80=tanker, etc.) | `70` |
| `Destination` | Crew-reported next port | `"HAMBURG"` |
| `ETA` | Crew-reported estimated arrival | `"03-22 14:00"` |
| `Draught` | Ship depth below waterline (meters) | `8.5` |
| `CallSign` | Radio call sign | `"DBBF"` |

### AISstream Message Types

AISstream delivers multiple message types. The two you care about:

- **`PositionReport`** — Real-time lat/lon, speed, heading, nav status. Sent every 2–10 seconds per vessel.
- **`ShipStaticData`** — Vessel name, IMO, type, dimensions, destination, ETA. Sent every 6 minutes.

You subscribe to both and merge them by MMSI on the server.

### Ship Type → Color Mapping

```
70–79  → Cargo Ship      → Green   #4ade80
80–89  → Tanker          → Red     #f87171
60–69  → Passenger       → Blue    #60a5fa
30     → Fishing         → Yellow  #facc15
50–59  → Special Craft   → Orange  #fb923c
1–9    → Reserved/Nav    → Gray    #94a3b8
Other  → Unknown         → White   #e2e8f0
```

---

## 5. Project Structure

Your ship tracking module lives as a sub-feature inside the ERP backend and frontend. Here is the file structure to create:

```
erp-backend/
├── src/
│   ├── tracking/
│   │   ├── aisClient.js          ← AISstream WebSocket connection
│   │   ├── vesselCache.js        ← In-memory vessel state (Map object)
│   │   ├── supabaseSync.js       ← Upserts to Supabase every N seconds
│   │   ├── sseManager.js         ← Manages SSE client connections
│   │   └── trackingRoutes.js     ← Express routes for this module
│   └── app.js                    ← Your existing Express app (add tracking routes here)
│
erp-frontend/
├── tracking/
│   ├── index.html                ← The map page
│   ├── map.js                    ← All map logic (Mapbox + SSE client)
│   └── tracking.css              ← Styles for the tracking UI
```

---

## 6. Environment Variables

Add these to your existing `.env` file (and to Render's environment settings):

```env
# AISstream
AISSTREAM_API_KEY=your_key_from_aisstream_io

# Supabase (you already have these)
SUPABASE_URL=https://yourproject.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Mapbox (frontend only — this key IS exposed to browser, that's fine for Mapbox)
MAPBOX_PUBLIC_TOKEN=pk.your_mapbox_public_token

# Tracking config
AIS_BOUNDING_BOX=[[[-90, -180], [90, 180]]]   # Global. Narrow this to your region to reduce load.
AIS_SYNC_INTERVAL_MS=5000                       # How often to batch-upsert to Supabase
AIS_MAX_VESSELS=5000                            # Cap in-memory vessels to prevent memory bloat
```

**Get your free AISstream key:** Sign up at [aisstream.io](https://aisstream.io), go to your account page, generate API key.

**Get your free Mapbox token:** Sign up at [mapbox.com](https://mapbox.com), go to Tokens page, copy the default public token.

---

## 7. Supabase Setup — Database Schema

Run this SQL in your Supabase SQL editor to create the vessels table:

```sql
-- Main vessel positions table
CREATE TABLE vessels (
  mmsi          TEXT PRIMARY KEY,
  imo           TEXT,
  name          TEXT,
  call_sign     TEXT,
  ship_type     INTEGER,
  latitude      DOUBLE PRECISION,
  longitude     DOUBLE PRECISION,
  sog           DOUBLE PRECISION,      -- speed over ground (knots)
  cog           DOUBLE PRECISION,      -- course over ground (degrees)
  true_heading  INTEGER,               -- 0-359, 511 = not available
  nav_status    INTEGER,               -- 0=underway, 1=anchored, 5=moored
  destination   TEXT,
  eta           TEXT,
  draught       DOUBLE PRECISION,
  last_seen     TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast geo queries (optional but good for future filtering)
CREATE INDEX idx_vessels_position ON vessels (latitude, longitude);
CREATE INDEX idx_vessels_ship_type ON vessels (ship_type);
CREATE INDEX idx_vessels_last_seen ON vessels (last_seen);

-- Auto-clean vessels not seen in 2 hours (keeps table lean)
-- Run this as a scheduled cron in Supabase (pg_cron extension):
-- SELECT cron.schedule('clean-stale-vessels', '0 * * * *',
--   'DELETE FROM vessels WHERE last_seen < NOW() - INTERVAL ''2 hours''');

-- Enable Row Level Security (keep data internal to your ERP)
ALTER TABLE vessels ENABLE ROW LEVEL SECURITY;

-- Allow your service role full access (backend uses service role key)
CREATE POLICY "service_role_all" ON vessels
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

---

## 8. Backend — Node.js/Express Server

### 8a. `src/tracking/aisClient.js` — AISstream WebSocket Client

This is the heart of the module. It connects to AISstream, receives AIS messages, and feeds them into your in-memory cache.

```javascript
const WebSocket = require('ws');
const vesselCache = require('./vesselCache');
const sseManager = require('./sseManager');

const AIS_WS_URL = 'wss://stream.aisstream.io/v0/stream';

// Bounding boxes: [min_lat, min_lon], [max_lat, max_lon]
// Global: [[-90, -180], [90, 180]] — narrows to a region to reduce message volume
const BOUNDING_BOXES = JSON.parse(process.env.AIS_BOUNDING_BOX || '[[[-90,-180],[90,180]]]');
const API_KEY = process.env.AISSTREAM_API_KEY;

let ws = null;
let reconnectTimer = null;
let isConnected = false;

function connect() {
  console.log('[AIS] Connecting to AISstream...');

  ws = new WebSocket(AIS_WS_URL);

  ws.on('open', () => {
    console.log('[AIS] Connected to AISstream.');
    isConnected = true;
    clearTimeout(reconnectTimer);

    // Send subscription message immediately on open (must arrive within 3 seconds or connection closes)
    const subscription = {
      Apikey: API_KEY,
      BoundingBoxes: BOUNDING_BOXES,
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    };
    ws.send(JSON.stringify(subscription));
    console.log('[AIS] Subscription sent.');
  });

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      handleMessage(msg);
    } catch (err) {
      console.error('[AIS] Failed to parse message:', err.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`[AIS] Disconnected. Code: ${code}. Reconnecting in 5s...`);
    isConnected = false;
    scheduleReconnect();
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
    const report = msg.Message?.PositionReport || {};
    const update = {
      mmsi,
      latitude: meta.Latitude ?? report.Latitude,
      longitude: meta.Longitude ?? report.Longitude,
      sog: report.Sog,
      cog: report.Cog,
      true_heading: report.TrueHeading,
      nav_status: report.NavigationalStatus,
      last_seen: new Date().toISOString(),
    };
    vesselCache.update(mmsi, update);
    // Push to SSE clients immediately on every position update
    sseManager.broadcast({ type: 'position', data: update });
  }

  if (type === 'ShipStaticData') {
    const staticData = msg.Message?.ShipStaticData || {};
    const update = {
      mmsi,
      name: staticData.Name?.trim(),
      imo: staticData.ImoNumber ? String(staticData.ImoNumber) : undefined,
      call_sign: staticData.CallSign?.trim(),
      ship_type: staticData.Type,
      destination: staticData.Destination?.trim(),
      eta: staticData.Eta,
      draught: staticData.MaximumStaticDraught,
    };
    vesselCache.update(mmsi, update);
    // Push static data update too (name/type may have just become known)
    sseManager.broadcast({ type: 'static', data: update });
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connect();
  }, 5000);
}

function getStatus() {
  return {
    connected: isConnected,
    vesselCount: vesselCache.size(),
  };
}

module.exports = { connect, getStatus };
```

---

### 8b. `src/tracking/vesselCache.js` — In-Memory Vessel State

```javascript
// In-memory Map: MMSI → vessel object
// This is the "live" state. Supabase is the persistent backup.
const vessels = new Map();
const MAX_VESSELS = parseInt(process.env.AIS_MAX_VESSELS || '5000');

function update(mmsi, fields) {
  const existing = vessels.get(mmsi) || { mmsi };
  // Merge: only overwrite fields that are defined (not undefined/null)
  const updated = { ...existing };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') {
      updated[key] = value;
    }
  }
  vessels.set(mmsi, updated);

  // If over cap, evict oldest-seen vessel
  if (vessels.size > MAX_VESSELS) {
    let oldestMMSI = null;
    let oldestTime = Infinity;
    for (const [m, v] of vessels.entries()) {
      const t = new Date(v.last_seen || 0).getTime();
      if (t < oldestTime) { oldestTime = t; oldestMMSI = m; }
    }
    if (oldestMMSI) vessels.delete(oldestMMSI);
  }
}

function getAll() {
  return Array.from(vessels.values());
}

function get(mmsi) {
  return vessels.get(mmsi);
}

function size() {
  return vessels.size;
}

module.exports = { update, getAll, get, size };
```

---

### 8c. `src/tracking/supabaseSync.js` — Persist to Supabase

```javascript
const { createClient } = require('@supabase/supabase-js');
const vesselCache = require('./vesselCache');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SYNC_INTERVAL = parseInt(process.env.AIS_SYNC_INTERVAL_MS || '5000');

// Batch upsert all in-memory vessels to Supabase every SYNC_INTERVAL ms.
// Using upsert with MMSI as primary key — safe to call repeatedly.
async function syncToSupabase() {
  const vessels = vesselCache.getAll();
  if (vessels.length === 0) return;

  // Filter: only upsert vessels that have at minimum a valid position
  const valid = vessels.filter(v => v.latitude != null && v.longitude != null);
  if (valid.length === 0) return;

  // Supabase upsert in chunks of 500 (Supabase REST limit)
  const CHUNK = 500;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const chunk = valid.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('vessels')
      .upsert(chunk, { onConflict: 'mmsi' });

    if (error) {
      console.error('[Supabase] Upsert error:', error.message);
    }
  }

  console.log(`[Supabase] Synced ${valid.length} vessels.`);
}

function startSync() {
  setInterval(syncToSupabase, SYNC_INTERVAL);
  console.log(`[Supabase] Sync started every ${SYNC_INTERVAL}ms.`);
}

module.exports = { startSync };
```

---

### 8d. `src/tracking/sseManager.js` — Server-Sent Events Manager

SSE lets the server push data to the browser over a plain HTTP connection. No WebSocket needed on the frontend side.

```javascript
// Set of active SSE response objects (one per connected browser tab)
const clients = new Set();

function addClient(res) {
  clients.add(res);
  console.log(`[SSE] Client connected. Total: ${clients.size}`);
  // Remove client when they disconnect
  res.on('close', () => {
    clients.delete(res);
    console.log(`[SSE] Client disconnected. Total: ${clients.size}`);
  });
}

function broadcast(payload) {
  if (clients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      client.write(data);
    } catch (err) {
      // Client probably disconnected mid-write
      clients.delete(client);
    }
  }
}

function clientCount() {
  return clients.size;
}

module.exports = { addClient, broadcast, clientCount };
```

---

### 8e. `src/tracking/trackingRoutes.js` — Express Routes

```javascript
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const vesselCache = require('./vesselCache');
const sseManager = require('./sseManager');
const aisClient = require('./aisClient');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// GET /api/tracking/vessels
// Returns all currently cached vessels as GeoJSON FeatureCollection.
// The frontend calls this once on page load to populate the map immediately.
router.get('/vessels', async (req, res) => {
  try {
    // First try in-memory cache (fastest)
    let vessels = vesselCache.getAll().filter(v => v.latitude != null && v.longitude != null);

    // If cache is empty (server just started), fall back to Supabase
    if (vessels.length === 0) {
      const { data, error } = await supabase
        .from('vessels')
        .select('*')
        .not('latitude', 'is', null)
        .not('longitude', 'is', null)
        .gt('last_seen', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()); // last 2h
      if (error) throw error;
      vessels = data || [];
    }

    // Format as GeoJSON FeatureCollection for Mapbox
    const geojson = {
      type: 'FeatureCollection',
      features: vessels.map(v => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [v.longitude, v.latitude],
        },
        properties: {
          mmsi: v.mmsi,
          name: v.name || 'Unknown',
          imo: v.imo || '',
          ship_type: v.ship_type || 0,
          sog: v.sog || 0,
          cog: v.cog || 0,
          true_heading: v.true_heading || 511,
          nav_status: v.nav_status ?? 15,
          destination: v.destination || '',
          eta: v.eta || '',
          draught: v.draught || 0,
          call_sign: v.call_sign || '',
          last_seen: v.last_seen,
        },
      })),
    };

    res.json(geojson);
  } catch (err) {
    console.error('[API] /vessels error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tracking/vessel/:mmsi
// Returns a single vessel's full data.
router.get('/vessel/:mmsi', (req, res) => {
  const vessel = vesselCache.get(req.params.mmsi);
  if (!vessel) return res.status(404).json({ error: 'Vessel not found in cache' });
  res.json(vessel);
});

// GET /api/tracking/stream
// SSE endpoint — browser connects here and receives live updates.
router.get('/stream', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering if applicable
  res.flushHeaders();

  // Send a heartbeat comment every 30s to keep the connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  res.on('close', () => {
    clearInterval(heartbeat);
  });

  sseManager.addClient(res);
});

// GET /api/tracking/status
// Health check endpoint.
router.get('/status', (req, res) => {
  res.json({
    ...aisClient.getStatus(),
    sseClients: sseManager.clientCount(),
  });
});

module.exports = router;
```

---

### 8f. Register Routes in `app.js`

In your existing Express app, add:

```javascript
const aisClient = require('./tracking/aisClient');
const supabaseSync = require('./tracking/supabaseSync');
const trackingRoutes = require('./tracking/trackingRoutes');

// Mount tracking API
app.use('/api/tracking', trackingRoutes);

// Start AIS stream and Supabase sync when server starts
aisClient.connect();
supabaseSync.startSync();
```

---

### 8g. Install Required npm Packages

```bash
npm install ws @supabase/supabase-js
```

(`express` you already have.)

---

## 9. Frontend — Map Page

### 9a. `tracking/index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ship Tracking — HUMANITY ERP</title>

  <!-- Mapbox GL JS v3 -->
  <link href="https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css" rel="stylesheet">
  <script src="https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js"></script>

  <link rel="stylesheet" href="tracking.css">
</head>
<body>

  <!-- Stats Bar -->
  <div id="stats-bar">
    <div class="stat">
      <span class="stat-value" id="stat-total">0</span>
      <span class="stat-label">Vessels Tracked</span>
    </div>
    <div class="stat">
      <span class="stat-value" id="stat-cargo">0</span>
      <span class="stat-label">Cargo</span>
    </div>
    <div class="stat">
      <span class="stat-value" id="stat-tanker">0</span>
      <span class="stat-label">Tankers</span>
    </div>
    <div class="stat">
      <span class="stat-value" id="stat-passenger">0</span>
      <span class="stat-label">Passenger</span>
    </div>
    <div class="stat">
      <span class="stat-value" id="stat-avg-speed">0</span>
      <span class="stat-label">Avg Speed (kn)</span>
    </div>
    <div class="stat-right">
      <span id="connection-status" class="status-dot connecting">●</span>
      <span id="connection-label">Connecting...</span>
    </div>
  </div>

  <!-- Filter Panel -->
  <div id="filter-panel">
    <div class="filter-title">FILTERS</div>

    <div class="filter-group">
      <label class="filter-label">Vessel Type</label>
      <div class="checkbox-group">
        <label><input type="checkbox" class="type-filter" value="cargo" checked> Cargo</label>
        <label><input type="checkbox" class="type-filter" value="tanker" checked> Tanker</label>
        <label><input type="checkbox" class="type-filter" value="passenger" checked> Passenger</label>
        <label><input type="checkbox" class="type-filter" value="fishing" checked> Fishing</label>
        <label><input type="checkbox" class="type-filter" value="other" checked> Other</label>
      </div>
    </div>

    <div class="filter-group">
      <label class="filter-label">Min Speed (knots): <span id="speed-val">0</span></label>
      <input type="range" id="speed-filter" min="0" max="30" value="0" step="1">
    </div>

    <div class="filter-group">
      <label class="filter-label">Nav Status</label>
      <select id="nav-filter">
        <option value="all">All</option>
        <option value="0">Underway (Engine)</option>
        <option value="1">Anchored</option>
        <option value="5">Moored</option>
      </select>
    </div>

    <button id="reset-filters">Reset Filters</button>
  </div>

  <!-- Map Container -->
  <div id="map"></div>

  <!-- Vessel Detail Popup (custom, not Mapbox default) -->
  <div id="vessel-popup" class="hidden">
    <div id="popup-header">
      <span id="popup-name">—</span>
      <button id="popup-close">✕</button>
    </div>
    <div id="popup-body">
      <div class="popup-row"><span class="popup-key">MMSI</span><span id="p-mmsi">—</span></div>
      <div class="popup-row"><span class="popup-key">IMO</span><span id="p-imo">—</span></div>
      <div class="popup-row"><span class="popup-key">Type</span><span id="p-type">—</span></div>
      <div class="popup-row"><span class="popup-key">Speed</span><span id="p-sog">—</span></div>
      <div class="popup-row"><span class="popup-key">Heading</span><span id="p-cog">—</span></div>
      <div class="popup-row"><span class="popup-key">Status</span><span id="p-status">—</span></div>
      <div class="popup-row"><span class="popup-key">Destination</span><span id="p-dest">—</span></div>
      <div class="popup-row"><span class="popup-key">ETA</span><span id="p-eta">—</span></div>
      <div class="popup-row"><span class="popup-key">Last Seen</span><span id="p-seen">—</span></div>
    </div>
  </div>

  <script>
    // Inject Mapbox token from server — never hardcode in HTML
    window.MAPBOX_TOKEN = '__MAPBOX_TOKEN__'; // Replace at serve time or use env injection
  </script>
  <script src="map.js" type="module"></script>
</body>
</html>
```

---

### 9b. `tracking/tracking.css`

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'Segoe UI', system-ui, sans-serif;
  background: #0a0f1a;
  color: #e2e8f0;
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* MAP */
#map {
  flex: 1;
  width: 100%;
}

/* STATS BAR */
#stats-bar {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 10px 20px;
  background: #0d1526;
  border-bottom: 1px solid rgba(255,255,255,0.07);
  z-index: 10;
  flex-shrink: 0;
}
.stat { display: flex; flex-direction: column; align-items: center; }
.stat-value { font-size: 18px; font-weight: 700; color: #f8fafc; line-height: 1; }
.stat-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
.stat-right { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12px; color: #94a3b8; }
.status-dot { font-size: 10px; }
.status-dot.connected { color: #4ade80; }
.status-dot.connecting { color: #facc15; }
.status-dot.disconnected { color: #f87171; }

/* FILTER PANEL */
#filter-panel {
  position: absolute;
  top: 64px;
  left: 16px;
  z-index: 20;
  background: rgba(13, 21, 38, 0.92);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  padding: 16px;
  width: 200px;
  backdrop-filter: blur(8px);
}
.filter-title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: #64748b;
  margin-bottom: 12px;
}
.filter-group { margin-bottom: 14px; }
.filter-label { font-size: 11px; color: #94a3b8; display: block; margin-bottom: 6px; }
.checkbox-group { display: flex; flex-direction: column; gap: 5px; }
.checkbox-group label { font-size: 12px; color: #cbd5e1; display: flex; align-items: center; gap: 6px; cursor: pointer; }
input[type="range"] { width: 100%; accent-color: #3b82f6; }
select {
  width: 100%;
  background: #131c2e;
  border: 1px solid rgba(255,255,255,0.1);
  color: #e2e8f0;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
}
#reset-filters {
  width: 100%;
  padding: 6px;
  background: rgba(59,130,246,0.15);
  border: 1px solid rgba(59,130,246,0.3);
  color: #60a5fa;
  border-radius: 5px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.2s;
}
#reset-filters:hover { background: rgba(59,130,246,0.25); }

/* VESSEL POPUP */
#vessel-popup {
  position: absolute;
  bottom: 30px;
  right: 20px;
  z-index: 20;
  background: rgba(13, 21, 38, 0.95);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 10px;
  padding: 16px;
  width: 260px;
  backdrop-filter: blur(10px);
}
#vessel-popup.hidden { display: none; }
#popup-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  padding-bottom: 10px;
}
#popup-name { font-size: 14px; font-weight: 700; color: #f8fafc; }
#popup-close {
  background: none;
  border: none;
  color: #64748b;
  cursor: pointer;
  font-size: 14px;
  padding: 0;
  line-height: 1;
}
.popup-row { display: flex; justify-content: space-between; margin-bottom: 6px; }
.popup-key { font-size: 11px; color: #64748b; }
#popup-body span:last-child { font-size: 11px; color: #e2e8f0; text-align: right; }
```

---

### 9c. `tracking/map.js` — Full Map Logic

```javascript
// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MAPBOX_TOKEN = window.MAPBOX_TOKEN;
const API_BASE = '/api/tracking'; // Adjust if your ERP mounts on a prefix

// Ship type → category mapping
const SHIP_TYPE_MAP = {
  cargo:     { range: [70, 79], color: '#4ade80', label: 'Cargo' },
  tanker:    { range: [80, 89], color: '#f87171', label: 'Tanker' },
  passenger: { range: [60, 69], color: '#60a5fa', label: 'Passenger' },
  fishing:   { range: [30, 30], color: '#facc15', label: 'Fishing' },
  special:   { range: [50, 59], color: '#fb923c', label: 'Special' },
};

function getVesselCategory(shipType) {
  for (const [cat, info] of Object.entries(SHIP_TYPE_MAP)) {
    if (shipType >= info.range[0] && shipType <= info.range[1]) return cat;
  }
  return 'other';
}

function getVesselColor(shipType) {
  for (const info of Object.values(SHIP_TYPE_MAP)) {
    if (shipType >= info.range[0] && shipType <= info.range[1]) return info.color;
  }
  return '#94a3b8'; // gray for unknown
}

const NAV_STATUS_LABELS = {
  0: 'Underway (Engine)', 1: 'Anchored', 2: 'Not Under Command',
  3: 'Restricted Maneuverability', 4: 'Constrained by Draught',
  5: 'Moored', 6: 'Aground', 7: 'Fishing', 8: 'Sailing',
  15: 'Not Defined',
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const vesselData = new Map(); // MMSI → feature properties
let geojsonData = { type: 'FeatureCollection', features: [] };
let filters = { types: new Set(['cargo', 'tanker', 'passenger', 'fishing', 'other']), minSpeed: 0, navStatus: 'all' };

// ─── MAP INIT ─────────────────────────────────────────────────────────────────
mapboxgl.accessToken = MAPBOX_TOKEN;

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/dark-v11',   // Dark nautical-style map
  center: [0, 20],                              // Default center (Atlantic)
  zoom: 2.5,
  projection: 'globe',                          // 3D globe projection
});

// Navigation controls
map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
map.addControl(new mapboxgl.ScaleControl({ unit: 'nautical' }), 'bottom-left');
map.addControl(new mapboxgl.FullscreenControl(), 'bottom-right');

// ─── LOAD MAP LAYERS ──────────────────────────────────────────────────────────
map.on('load', async () => {
  // Add vessel SVG icon to Mapbox sprite
  await addShipIcon();

  // Add GeoJSON source (empty initially)
  map.addSource('vessels', {
    type: 'geojson',
    data: geojsonData,
    // Cluster nearby vessels when zoomed out
    cluster: true,
    clusterMaxZoom: 6,
    clusterRadius: 40,
  });

  // Cluster circle layer
  map.addLayer({
    id: 'vessel-clusters',
    type: 'circle',
    source: 'vessels',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': ['step', ['get', 'point_count'],
        '#334155', 10,   // < 10 vessels
        '#1e40af', 50,   // 10–50
        '#7c3aed',       // > 50
      ],
      'circle-radius': ['step', ['get', 'point_count'],
        18, 10,
        24, 50,
        32,
      ],
      'circle-opacity': 0.85,
    },
  });

  // Cluster count label
  map.addLayer({
    id: 'vessel-cluster-count',
    type: 'symbol',
    source: 'vessels',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': '{point_count_abbreviated}',
      'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
      'text-size': 13,
    },
    paint: { 'text-color': '#f8fafc' },
  });

  // Individual vessel layer (shown when not clustered)
  map.addLayer({
    id: 'vessel-symbols',
    type: 'symbol',
    source: 'vessels',
    filter: ['!', ['has', 'point_count']],
    layout: {
      'icon-image': 'ship-arrow',
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        3, 0.4,
        6, 0.7,
        10, 1.0,
      ],
      // Rotate icon to match heading (true heading preferred, fall back to COG)
      'icon-rotate': ['case',
        ['==', ['get', 'true_heading'], 511],
        ['get', 'cog'],
        ['get', 'true_heading'],
      ],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      // Color the icon by vessel type
      'icon-color': ['case',
        ['>=', ['get', 'ship_type'], 70], ['<', ['get', 'ship_type'], 80], '#4ade80',  // cargo
        ['>=', ['get', 'ship_type'], 80], ['<', ['get', 'ship_type'], 90], '#f87171',  // tanker
        ['>=', ['get', 'ship_type'], 60], ['<', ['get', 'ship_type'], 70], '#60a5fa',  // passenger
        ['==', ['get', 'ship_type'], 30], '#facc15',                                   // fishing
        '#94a3b8',
      ],
      'icon-opacity': 0.92,
      'icon-halo-color': '#0a0f1a',
      'icon-halo-width': 1,
    },
  });

  // Load initial vessel data from API
  await loadInitialVessels();

  // Connect to live SSE stream
  connectSSE();

  // Wire up filters
  setupFilters();
});

// ─── SHIP ICON ────────────────────────────────────────────────────────────────
async function addShipIcon() {
  // Render a small arrow SVG as a Mapbox icon image
  // The arrow points UP (north) by default — Mapbox rotates it per heading
  const svg = `
    <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <polygon points="12,2 20,22 12,17 4,22" fill="white"/>
    </svg>`;

  return new Promise((resolve) => {
    const img = new Image(24, 24);
    img.onload = () => {
      if (!map.hasImage('ship-arrow')) {
        map.addImage('ship-arrow', img, { sdf: true }); // SDF = true enables icon-color tinting
      }
      resolve();
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

// ─── INITIAL DATA LOAD ────────────────────────────────────────────────────────
async function loadInitialVessels() {
  try {
    const res = await fetch(`${API_BASE}/vessels`);
    const geojson = await res.json();

    // Store all features in local map
    for (const feature of geojson.features) {
      vesselData.set(feature.properties.mmsi, feature);
    }

    renderMap();
    updateStats();
  } catch (err) {
    console.error('[Map] Failed to load initial vessels:', err);
  }
}

// ─── SSE CONNECTION ───────────────────────────────────────────────────────────
function connectSSE() {
  setConnectionStatus('connecting');

  const es = new EventSource(`${API_BASE}/stream`);

  es.onopen = () => {
    setConnectionStatus('connected');
  };

  es.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'position') {
        updateVesselPosition(msg.data);
      } else if (msg.type === 'static') {
        updateVesselStatic(msg.data);
      }
    } catch (err) {
      console.error('[SSE] Parse error:', err);
    }
  };

  es.onerror = () => {
    setConnectionStatus('disconnected');
    // EventSource auto-reconnects — no manual reconnect needed
  };
}

// ─── VESSEL STATE UPDATE ──────────────────────────────────────────────────────
function updateVesselPosition(data) {
  const existing = vesselData.get(data.mmsi);
  const props = existing ? { ...existing.properties, ...data } : data;

  const feature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [data.longitude, data.latitude] },
    properties: {
      mmsi: props.mmsi,
      name: props.name || 'Unknown',
      imo: props.imo || '',
      ship_type: props.ship_type || 0,
      sog: props.sog || 0,
      cog: props.cog || 0,
      true_heading: props.true_heading ?? 511,
      nav_status: props.nav_status ?? 15,
      destination: props.destination || '',
      eta: props.eta || '',
      draught: props.draught || 0,
      call_sign: props.call_sign || '',
      last_seen: props.last_seen,
    },
  };

  vesselData.set(data.mmsi, feature);

  // Throttle full re-render: batch updates and render every 500ms
  scheduleRender();
}

function updateVesselStatic(data) {
  const existing = vesselData.get(data.mmsi);
  if (existing) {
    // Merge static data into existing feature
    Object.assign(existing.properties, {
      name: data.name || existing.properties.name,
      imo: data.imo || existing.properties.imo,
      ship_type: data.ship_type || existing.properties.ship_type,
      destination: data.destination || existing.properties.destination,
      eta: data.eta || existing.properties.eta,
      call_sign: data.call_sign || existing.properties.call_sign,
    });
    vesselData.set(data.mmsi, existing);
  }
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  setTimeout(() => {
    renderMap();
    updateStats();
    renderScheduled = false;
  }, 500); // Batch updates every 500ms
}

function renderMap() {
  const source = map.getSource('vessels');
  if (!source) return;

  // Apply filters
  const filtered = applyFilters(Array.from(vesselData.values()));

  geojsonData = { type: 'FeatureCollection', features: filtered };
  source.setData(geojsonData);
}

function applyFilters(features) {
  return features.filter(f => {
    const p = f.properties;
    const cat = getVesselCategory(p.ship_type);
    if (!filters.types.has(cat) && !filters.types.has('other')) {
      if (!Object.keys(SHIP_TYPE_MAP).includes(cat)) return false;
      if (!filters.types.has(cat)) return false;
    }
    if (p.sog < filters.minSpeed) return false;
    if (filters.navStatus !== 'all' && p.nav_status !== parseInt(filters.navStatus)) return false;
    return true;
  });
}

// ─── STATS BAR ────────────────────────────────────────────────────────────────
function updateStats() {
  const all = Array.from(vesselData.values());
  document.getElementById('stat-total').textContent = all.length.toLocaleString();

  const cargo = all.filter(f => getVesselCategory(f.properties.ship_type) === 'cargo').length;
  const tanker = all.filter(f => getVesselCategory(f.properties.ship_type) === 'tanker').length;
  const passenger = all.filter(f => getVesselCategory(f.properties.ship_type) === 'passenger').length;
  const avgSpeed = all.length ? (all.reduce((s, f) => s + (f.properties.sog || 0), 0) / all.length).toFixed(1) : '0';

  document.getElementById('stat-cargo').textContent = cargo.toLocaleString();
  document.getElementById('stat-tanker').textContent = tanker.toLocaleString();
  document.getElementById('stat-passenger').textContent = passenger.toLocaleString();
  document.getElementById('stat-avg-speed').textContent = avgSpeed;
}

// ─── CLICK → POPUP ────────────────────────────────────────────────────────────
map.on('click', 'vessel-symbols', (e) => {
  const props = e.features[0].properties;
  showPopup(props);
});

map.on('click', 'vessel-clusters', (e) => {
  const features = map.queryRenderedFeatures(e.point, { layers: ['vessel-clusters'] });
  const clusterId = features[0].properties.cluster_id;
  map.getSource('vessels').getClusterExpansionZoom(clusterId, (err, zoom) => {
    if (err) return;
    map.easeTo({ center: features[0].geometry.coordinates, zoom });
  });
});

// Cursor change on hover
map.on('mouseenter', 'vessel-symbols', () => map.getCanvas().style.cursor = 'pointer');
map.on('mouseleave', 'vessel-symbols', () => map.getCanvas().style.cursor = '');
map.on('mouseenter', 'vessel-clusters', () => map.getCanvas().style.cursor = 'pointer');
map.on('mouseleave', 'vessel-clusters', () => map.getCanvas().style.cursor = '');

function showPopup(props) {
  document.getElementById('popup-name').textContent = props.name || 'Unknown Vessel';
  document.getElementById('p-mmsi').textContent = props.mmsi || '—';
  document.getElementById('p-imo').textContent = props.imo || '—';
  document.getElementById('p-type').textContent = SHIP_TYPE_MAP[getVesselCategory(props.ship_type)]?.label || `Type ${props.ship_type}`;
  document.getElementById('p-sog').textContent = props.sog != null ? `${props.sog} kn` : '—';
  document.getElementById('p-cog').textContent = props.cog != null ? `${props.cog}°` : '—';
  document.getElementById('p-status').textContent = NAV_STATUS_LABELS[props.nav_status] || 'Unknown';
  document.getElementById('p-dest').textContent = props.destination || '—';
  document.getElementById('p-eta').textContent = props.eta || '—';
  document.getElementById('p-seen').textContent = props.last_seen
    ? new Date(props.last_seen).toLocaleTimeString()
    : '—';
  document.getElementById('vessel-popup').classList.remove('hidden');
}

document.getElementById('popup-close').addEventListener('click', () => {
  document.getElementById('vessel-popup').classList.add('hidden');
});

// ─── FILTERS ──────────────────────────────────────────────────────────────────
function setupFilters() {
  document.querySelectorAll('.type-filter').forEach(cb => {
    cb.addEventListener('change', () => {
      filters.types = new Set(
        Array.from(document.querySelectorAll('.type-filter:checked')).map(c => c.value)
      );
      renderMap();
    });
  });

  document.getElementById('speed-filter').addEventListener('input', (e) => {
    filters.minSpeed = parseFloat(e.target.value);
    document.getElementById('speed-val').textContent = filters.minSpeed;
    renderMap();
  });

  document.getElementById('nav-filter').addEventListener('change', (e) => {
    filters.navStatus = e.target.value;
    renderMap();
  });

  document.getElementById('reset-filters').addEventListener('click', () => {
    filters = { types: new Set(['cargo', 'tanker', 'passenger', 'fishing', 'other']), minSpeed: 0, navStatus: 'all' };
    document.querySelectorAll('.type-filter').forEach(cb => cb.checked = true);
    document.getElementById('speed-filter').value = 0;
    document.getElementById('speed-val').textContent = '0';
    document.getElementById('nav-filter').value = 'all';
    renderMap();
  });
}

// ─── CONNECTION STATUS ────────────────────────────────────────────────────────
function setConnectionStatus(state) {
  const dot = document.getElementById('connection-status');
  const label = document.getElementById('connection-label');
  dot.className = `status-dot ${state}`;
  label.textContent = state === 'connected' ? 'Live' : state === 'connecting' ? 'Connecting...' : 'Reconnecting...';
}
```

---

## 10. Data Flow — Step by Step

```
BOOT SEQUENCE
─────────────
1. Render spins up your Node.js server
2. aisClient.connect() opens WebSocket to AISstream
3. Subscription message sent: global bounding box, PositionReport + ShipStaticData
4. supabaseSync.startSync() begins 5-second batch upsert loop

USER OPENS /erp/tracking PAGE
───────────────────────────────
5. Browser loads index.html → map.js initializes Mapbox map
6. map.js calls GET /api/tracking/vessels
7. Server returns GeoJSON from in-memory cache (or Supabase if cache is cold)
8. Mapbox renders all vessels immediately — map is populated before SSE connects
9. map.js opens EventSource to GET /api/tracking/stream
10. Server registers this browser as an SSE client

LIVE UPDATES (ongoing)
────────────────────────
11. Ship broadcasts AIS position → AISstream receives it
12. AISstream pushes JSON to your Node.js WebSocket
13. handleMessage() extracts MMSI, lat, lon, speed, heading
14. vesselCache.update() merges into in-memory Map
15. sseManager.broadcast() pushes JSON to all SSE clients instantly
16. Browser's EventSource onmessage fires
17. updateVesselPosition() updates vesselData Map
18. scheduleRender() triggers a GeoJSON re-render 500ms later
19. Mapbox source.setData() — GPU re-renders all vessel icons in place
    Ship arrows rotate to new headings. Colors stay by type.

SUPABASE SYNC (every 5 seconds)
────────────────────────────────
20. syncToSupabase() reads vesselCache.getAll()
21. Batch upserts all vessels with valid positions to Supabase
22. On next cold start, step 7 fetches these positions from Supabase
```

---

## 11. Reconnection and Resilience

### AISstream WebSocket Reconnection

Already handled in `aisClient.js` — on any `close` or `error` event, it schedules a reconnect after 5 seconds. No data loss because Supabase holds the last-known positions.

### SSE Client Resilience

`EventSource` in the browser reconnects automatically on any connection drop. No code needed.

### What Happens When AISstream Goes Down

- Vessel positions on the map freeze at their last-known positions
- The connection status dot turns orange "Reconnecting..."
- When AISstream comes back, positions resume updating
- Supabase holds all positions from the last sync — nothing is lost

### Handle AISstream's Message Throughput Limit

For global subscriptions, AISstream can send up to ~300 messages/second. Your Node.js server must process these faster than they arrive. The `ws` package processes them synchronously in the `onmessage` handler — this is fast enough. However, if you subscribe globally and have a low-spec Render instance (512MB RAM), consider narrowing your bounding box to a specific ocean region to reduce volume.

---

## 12. Performance Considerations

### Frontend

- **Use GeoJSON layers, never DOM markers.** Mapbox renders GeoJSON via WebGL on the GPU. 10,000 vessels = no lag. Individual `<div>` markers for 10,000 ships would freeze the browser.
- **Cluster at low zoom levels.** Already configured in the source setup — Mapbox clusters automatically at zoom < 6.
- **Batch render calls.** `scheduleRender()` coalesces multiple rapid SSE messages into one re-render every 500ms. Without this, 300 messages/second would trigger 300 GeoJSON rebuilds/second.

### Backend

- **In-memory Map for live state.** `vesselCache` uses a plain JavaScript `Map` — O(1) reads and writes. Never query Supabase for live data.
- **Async Supabase sync.** The sync loop runs independently of the AIS message handler. A slow Supabase response never blocks AIS processing.
- **Limit in-memory vessel count.** `AIS_MAX_VESSELS=5000` prevents the Node.js process from consuming unbounded memory if you subscribe globally.

### Supabase

- The `vessels` table uses `mmsi` as primary key. Upserts are idempotent — running them multiple times is safe.
- Add the `last_seen` index — it makes the 2-hour stale data filter fast on cold start.

---

## 13. Deploying on Render

Your backend already runs on Render tracking the `develop` branch. No new service needed — the ship tracking module runs inside your existing Node.js server.

### Render Environment Variables to Add

In Render dashboard → Your service → Environment:

```
AISSTREAM_API_KEY        = your key
AIS_BOUNDING_BOX         = [[[-90,-180],[90,180]]]
AIS_SYNC_INTERVAL_MS     = 5000
AIS_MAX_VESSELS          = 5000
MAPBOX_PUBLIC_TOKEN      = pk.your_mapbox_token
```

### Important: WebSocket Stays Alive on Render

Render free/hobby tier does not kill long-lived WebSocket connections from server-side. Your Node.js server initiates the WebSocket to AISstream (outbound), which Render allows. Only inbound WebSocket connections to Render require paid tiers.

### SSE and Render

Server-Sent Events are plain HTTP — fully supported on all Render tiers. The SSE response stays open as long as the browser tab is open.

---

## 14. ERP Integration Points

### Add to Your ERP Navigation

```html
<a href="/erp/tracking">🚢 Ship Tracking</a>
```

### Serve the Tracking Page from Express

```javascript
// In your existing app.js or routes file
const path = require('path');

// Inject Mapbox token server-side (keeps it out of static HTML)
app.get('/erp/tracking', (req, res) => {
  // Read the HTML, replace the placeholder with the real token, send
  let html = require('fs').readFileSync(
    path.join(__dirname, '../erp-frontend/tracking/index.html'), 'utf8'
  );
  html = html.replace('__MAPBOX_TOKEN__', process.env.MAPBOX_PUBLIC_TOKEN);
  res.send(html);
});

// Serve static JS/CSS for the tracking page
app.use('/erp/tracking/static', express.static(
  path.join(__dirname, '../erp-frontend/tracking')
));
```

Update `index.html` script src: `<script src="/erp/tracking/static/map.js" type="module"></script>`

### ERP Database Linkage (Optional — Future)

Once the `vessels` table is in Supabase, you can join it to ERP data:

```sql
-- Example: Link a shipment record to a tracked vessel by MMSI
SELECT
  s.shipment_id,
  s.cargo_description,
  v.name AS vessel_name,
  v.latitude,
  v.longitude,
  v.sog,
  v.destination,
  v.last_seen
FROM shipments s
JOIN vessels v ON s.vessel_mmsi = v.mmsi
WHERE s.status = 'in_transit';
```

Add a `vessel_mmsi` column to your `shipments` table to enable this.

---

## 15. Full File Listing

Files to create for this module:

```
erp-backend/src/tracking/
  aisClient.js          ← AISstream WebSocket + reconnect logic
  vesselCache.js        ← In-memory vessel state (Map)
  supabaseSync.js       ← Batch upsert to Supabase every 5s
  sseManager.js         ← Manages browser SSE connections
  trackingRoutes.js     ← Express routes: /vessels, /vessel/:mmsi, /stream, /status

erp-backend/src/
  app.js                ← EDIT: add 3 lines to mount tracking module

erp-frontend/tracking/
  index.html            ← Map page HTML
  map.js                ← Mapbox GL JS + SSE client + filters + popup
  tracking.css          ← All styles

Supabase SQL Editor:
  vessels table + indexes + RLS policy  ← Run once

Render Environment:
  AISSTREAM_API_KEY, AIS_BOUNDING_BOX, AIS_SYNC_INTERVAL_MS,
  AIS_MAX_VESSELS, MAPBOX_PUBLIC_TOKEN  ← Add to your service
```

---

## Quick Start Checklist for Claude Code

When you open Claude Code, give it this document and say:

> "Build the ship tracking module as described in this document. Start with `aisClient.js`, `vesselCache.js`, `supabaseSync.js`, `sseManager.js`, and `trackingRoutes.js` in `src/tracking/`. Then create the three frontend files in `erp-frontend/tracking/`. Finally, show me the 3 lines to add to `app.js`."

**Order of build:**
1. Supabase SQL — run in Supabase SQL editor first
2. Add env vars to `.env` and Render
3. Install: `npm install ws @supabase/supabase-js`
4. Build backend files (`src/tracking/`)
5. Update `app.js`
6. Build frontend files (`erp-frontend/tracking/`)
7. Test locally — open `/erp/tracking`, check browser console for SSE messages
8. Deploy to Render — check `/api/tracking/status` endpoint for AIS connection status

---

*Built for HUMANITY ERP · AISstream.io + Node.js/Express + Supabase + Mapbox GL JS*
