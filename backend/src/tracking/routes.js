const express       = require('express');
const router        = express.Router();
const vesselCache   = require('./vesselCache');
const sseManager    = require('./sseManager');
const aisClient     = require('./aisClient');
const store         = require('./shipmentsStore');

// ── GET /api/shipments ─────────────────────────────────────────────
// Returns all tracked shipments merged with latest AIS position data.
router.get('/shipments', (req, res) => {
  const shipments = store.getAll();
  const enriched  = shipments.map(s => {
    const live = vesselCache.get(s.mmsi);
    return { ...s, live: live || null };
  });
  res.json(enriched);
});

// ── POST /api/shipments ────────────────────────────────────────────
// Add a new shipment to track.
router.post('/shipments', (req, res) => {
  const { mmsi, po_number, cargo, cargo_type, quantity, supplier,
          supplier_country, origin_port, dest_warehouse, eta, notes } = req.body;

  if (!mmsi || !/^\d{9}$/.test(String(mmsi).trim())) {
    return res.status(400).json({ error: 'MMSI must be exactly 9 digits.' });
  }

  const entry = store.add({
    mmsi: String(mmsi).trim(),
    po_number, cargo, cargo_type, quantity, supplier,
    supplier_country, origin_port, dest_warehouse, eta, notes,
  });

  // Update AISstream subscription to include the new MMSI
  aisClient.refreshSubscription();

  res.status(201).json(entry);
});

// ── DELETE /api/shipments/:id ──────────────────────────────────────
router.delete('/shipments/:id', (req, res) => {
  store.remove(req.params.id);
  aisClient.refreshSubscription();
  res.json({ ok: true });
});

// ── GET /api/stream ────────────────────────────────────────────────
// SSE — browser connects once and receives all live updates.
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Heartbeat every 25s to keep connection alive through proxies
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000);
  res.on('close', () => clearInterval(hb));

  sseManager.add(res);
});

// ── GET /api/status ────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    ...aisClient.status(),
    sseClients:      sseManager.count(),
    trackedShipments: store.getAll().length,
    uptime:          process.uptime(),
  });
});

// ── GET /api/vessel/:mmsi ──────────────────────────────────────────
// Raw AIS cache for a single vessel (debug / advanced use).
router.get('/vessel/:mmsi', (req, res) => {
  const v = vesselCache.get(req.params.mmsi);
  if (!v) return res.status(404).json({ error: 'Not in AIS cache — vessel may not be broadcasting.' });
  res.json(v);
});

module.exports = router;
