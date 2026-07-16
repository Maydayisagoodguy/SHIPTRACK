const express = require('express');
const router = express.Router();
const vesselCache = require('./vesselCache');
const sseManager = require('./sseManager');
const trackingManager = require('./trackingManager');
const routeService = require('./routeService');
const eventStore = require('./eventStore');
const database = require('../persistence/database');
const store = require('./shipmentsStore');

router.get('/shipments', (req, res) => {
  const shipments = store.getAll();
  const enriched = shipments.map((shipment) => {
    const vessel = vesselCache.get(shipment.mmsi);
    return {
      ...shipment,
      live: vessel ? { ...vessel, quality: vesselCache.quality(vessel) } : null,
      tracking: vesselCache.quality(vessel),
    };
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(enriched);
});

router.post('/shipments', (req, res) => {
  const { mmsi, po_number, cargo, cargo_type, quantity, supplier,
    supplier_country, origin_port, dest_warehouse, eta, notes } = req.body;

  if (!mmsi || !/^\d{9}$/.test(String(mmsi).trim())) {
    return res.status(400).json({ error: 'MMSI must be exactly 9 digits.' });
  }

  const entry = store.add({
    mmsi: String(mmsi).trim(),
    po_number,
    cargo,
    cargo_type,
    quantity,
    supplier,
    supplier_country,
    origin_port,
    dest_warehouse,
    eta,
    notes,
  });

  trackingManager.refresh();
  res.status(201).json(entry);
});

router.delete('/shipments/:id', (req, res) => {
  store.remove(req.params.id);
  trackingManager.refresh();
  res.json({ ok: true });
});

router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch {}
  }, 25000);
  res.on('close', () => clearInterval(heartbeat));
  sseManager.add(res);
});

router.get('/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ...trackingManager.status(),
    routing: routeService.status(),
    database: database.status(),
    sseClients: sseManager.count(),
    trackedShipments: store.getAll().length,
    uptime: process.uptime(),
  });
});

router.get('/vessel/:mmsi', (req, res) => {
  const vessel = vesselCache.get(req.params.mmsi);
  if (!vessel) return res.status(404).json({ error: 'No AIS position is cached for this vessel.' });
  res.json({ ...vessel, quality: vesselCache.quality(vessel) });
});

router.get('/track/:mmsi', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(vesselCache.getTrack(req.params.mmsi));
});

router.get('/route/:shipmentId', async (req, res) => {
  const shipment = store.getById(req.params.shipmentId);
  if (!shipment) return res.status(404).json({ error: 'Shipment not found.' });
  try {
    const vessel = vesselCache.get(shipment.mmsi);
    const force = req.query.refresh === 'true';
    const route = await routeService.getRoute(shipment, vessel, force);
    res.setHeader('Cache-Control', 'no-store');
    res.json(route);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.get('/events/:shipmentId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(eventStore.forShipment(req.params.shipmentId));
});

module.exports = router;
