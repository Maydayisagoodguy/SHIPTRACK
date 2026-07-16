const fs = require('fs');
const path = require('path');
const eventStore = require('./eventStore');
const database = require('../persistence/database');

const API_KEY = process.env.SEAROUTES_API_KEY;
const TTL_MS = parseInt(process.env.SEAROUTES_ROUTE_TTL_MS || '86400000', 10);
const CACHE_FILE = path.join(__dirname, '../../data/routes-cache.json');

const PORTS = {
  shanghai: [121.47, 31.23], tianjin: [117.70, 38.97], singapore: [103.82, 1.27],
  colombo: [79.85, 6.93], mumbai: [72.84, 18.93], mundra: [69.67, 22.84],
  chennai: [80.29, 13.08], delhi: [72.84, 18.93], bangalore: [80.29, 13.08],
  jebel: [55.07, 25], rotterdam: [4.17, 51.9], hamburg: [9.95, 53.54],
};
const LANDMARKS = [
  ['Singapore Strait', 103.82, 1.27], ['Colombo', 79.85, 6.93],
  ['Suez Canal', 32.42, 30.55], ['Strait of Hormuz', 56.5, 26.5],
  ['Gulf of Aden', 48.5, 12.2], ['Strait of Gibraltar', -5.55, 35.95],
  ['Malacca Strait', 101.6, 2.8], ['Bab el-Mandeb', 43.3, 12.6],
];
const LANES = {
  '353136000': [PORTS.shanghai, [121.8,25], [112,15], PORTS.singapore, [94,10], [87,12], [80.5,8], [74.5,16.5], PORTS.mumbai],
  '255805734': [PORTS.rotterdam, [3,54], [-2,49.5], [-5.45,36.13], [10,38], [26,35], [32.3,31.27], [32.55,29.97], [38,20], [50,12], [64,18], PORTS.mumbai, PORTS.colombo, PORTS.chennai],
  '219019791': [PORTS.hamburg, [3,54], [-2,49.5], [-5.45,36.13], [10,38], [26,35], [32.3,31.27], [32.55,29.97], [38,20], [50,12], [64,18], PORTS.mumbai],
  '477931700': [PORTS.tianjin, PORTS.shanghai, [112,15], PORTS.singapore, [94,10], [87,12], [80.5,8], [64,18], PORTS.mundra, PORTS.mumbai],
  '228372500': [PORTS.jebel, [56.5,26.5], [61,22], [64,18], PORTS.mumbai],
};

function configured() {
  return Boolean(API_KEY && API_KEY !== 'your_searoutes_trial_key_here');
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function writeCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

async function getRoute(shipment, vessel, force = false) {
  const cache = readCache();
  const saved = cache[shipment.id];
  const providerUpgrade = configured() && saved?.source !== 'Searoutes';
  if (!force && !providerUpgrade && saved && Date.now() - new Date(saved.generatedAt).getTime() < TTL_MS) {
    return evaluate(saved, shipment, vessel);
  }

  let route;
  if (configured()) {
    try { route = await fetchSearoutes(shipment, vessel); }
    catch (error) {
      console.error('[Searoutes] Route failed:', error.message);
      route = buildFallback(shipment);
      route.warning = error.message;
    }
  } else {
    route = buildFallback(shipment);
  }

  cache[shipment.id] = route;
  writeCache(cache);
  database.saveRoute(shipment.id, route);
  return evaluate(route, shipment, vessel);
}

async function fetchSearoutes(shipment, vessel) {
  const origin = resolveLocation(shipment.origin_unlocode || shipment.origin_port);
  const destination = resolveLocation(shipment.dest_unlocode || shipment.dest_warehouse);
  if (!origin || !destination) throw new Error('Origin or destination could not be resolved');

  const locations = `${formatLocation(origin)};${formatLocation(destination)}`;
  const url = new URL(`https://api.searoutes.com/route/v2/sea/${locations}/plan`);
  url.searchParams.set('continuousCoordinates', 'false');
  url.searchParams.set('avoidHRA', 'true');
  if (vessel?.imo && /^\d{7}$/.test(String(vessel.imo))) url.searchParams.set('imo', vessel.imo);
  if (Number(vessel?.sog) > 2) url.searchParams.set('speedInKts', Number(vessel.sog).toFixed(1));
  if (Number(vessel?.draught) > 0) url.searchParams.set('vesselDraft', Number(vessel.draught).toFixed(1));

  const response = await fetch(url, {
    headers: { 'x-api-key': API_KEY },
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `Searoutes HTTP ${response.status}`);

  const features = payload.features || (payload.type === 'Feature' ? [payload] : []);
  const coordinates = mergeCoordinates(features.map((item) => item.geometry?.coordinates).filter(Array.isArray));
  if (coordinates.length < 2) throw new Error('Searoutes returned no route geometry');
  const properties = features[0]?.properties || payload.properties || {};
  const providerWaypoints = features.flatMap((item) => item.properties?.waypoints || []);
  const checkpoints = buildCheckpoints(coordinates, shipment, providerWaypoints);

  return {
    source: 'Searoutes',
    verifiedRouting: true,
    generatedAt: new Date().toISOString(),
    geometry: { type: 'LineString', coordinates },
    distanceNm: Number(properties.distance || payload.distance || routeDistance(coordinates) * 1852) / 1852,
    durationMs: Number(properties.duration || payload.duration || 0) || null,
    checkpoints,
  };
}

function buildFallback(shipment) {
  const origin = resolveLocation(shipment.origin_port);
  const destination = resolveLocation(shipment.dest_warehouse);
  const control = LANES[shipment.mmsi] || (origin && destination ? [origin, destination] : []);
  const coordinates = smooth(control, 18);
  return {
    source: 'Prototype route',
    verifiedRouting: false,
    generatedAt: new Date().toISOString(),
    geometry: { type: 'LineString', coordinates },
    distanceNm: routeDistance(coordinates),
    durationMs: null,
    checkpoints: buildCheckpoints(coordinates, shipment, []),
  };
}

function buildCheckpoints(route, shipment, providerWaypoints) {
  const checkpoints = [];
  addCheckpoint(checkpoints, 'origin', shortName(shipment.origin_port, 'Origin'), route[0], 'origin', 0);
  providerWaypoints.forEach((waypoint, index) => {
    const coordinate = waypoint.geometry?.coordinates || waypoint.coordinates || waypoint.location?.coordinates;
    if (!Array.isArray(coordinate)) return;
    const projection = nearestProjection(route, coordinate);
    addCheckpoint(checkpoints, `provider-${index}`, waypoint.name || waypoint.areaName || waypoint.type || 'Route checkpoint', coordinate, String(waypoint.type || 'routing').toLowerCase(), projection.progress);
  });
  for (const [name, lon, lat] of LANDMARKS) {
    const projection = nearestProjection(route, [lon, lat]);
    if (projection.distanceNm <= 140 && projection.progress > .04 && projection.progress < .96) {
      addCheckpoint(checkpoints, slug(name), name, projection.point, 'chokepoint', projection.progress);
    }
  }
  addCheckpoint(checkpoints, 'destination', shortName(shipment.dest_warehouse, 'Destination'), route[route.length - 1], 'destination', 1);
  return checkpoints.sort((a, b) => a.progress - b.progress).slice(0, 14);
}

function evaluate(route, shipment, vessel) {
  const result = JSON.parse(JSON.stringify(route));
  const point = vessel && finite(vessel.longitude) !== null && finite(vessel.latitude) !== null
    ? [Number(vessel.longitude), Number(vessel.latitude)] : null;
  const projection = point ? nearestProjection(result.geometry.coordinates, point) : null;
  const progress = projection?.progress ?? 0;
  const observedAt = vessel?.position_at || null;

  result.progress = projection ? progress : null;
  result.deviationNm = projection?.distanceNm ?? null;
  result.distanceRemainingNm = projection ? Math.max(0, result.distanceNm * (1 - progress)) : result.distanceNm;
  result.checkpoints = result.checkpoints.map((checkpoint) => {
    const distanceFromVessel = point ? haversine(point, checkpoint.coordinates) : null;
    const reached = projection && (progress > checkpoint.progress + .004 || distanceFromVessel <= checkpointRadius(checkpoint.type));
    const status = reached ? 'reached' : 'upcoming';
    if (reached && observedAt) {
      eventStore.add({
        shipmentId: shipment.id,
        mmsi: shipment.mmsi,
        type: 'checkpoint_reached',
        checkpointId: checkpoint.id,
        checkpointName: checkpoint.name,
        occurredAt: observedAt,
        position: point,
      });
    }
    return { ...checkpoint, status, distanceFromVesselNm: distanceFromVessel };
  });
  const reached = result.checkpoints.filter((item) => item.status === 'reached');
  result.lastCheckpoint = reached.at(-1) || null;
  result.nextCheckpoint = result.checkpoints.find((item) => item.status === 'upcoming') || null;
  result.events = eventStore.forShipment(shipment.id).slice(0, 20);
  result.providerConfigured = configured();
  return result;
}

function resolveLocation(value) {
  if (Array.isArray(value) && value.length === 2) return value;
  const text = String(value || '').trim();
  if (/^[A-Z]{2}[A-Z0-9]{3}$/.test(text)) return text;
  const lower = text.toLowerCase();
  const key = Object.keys(PORTS).find((name) => lower.includes(name));
  return key ? PORTS[key] : null;
}

function formatLocation(value) { return Array.isArray(value) ? `${value[0]},${value[1]}` : value; }
function shortName(value, fallback) { return String(value || fallback).split(',')[0].replace(/ warehouse hub| warehouse| distribution center/ig, '').trim(); }
function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function checkpointRadius(type) { return type === 'destination' || type === 'origin' ? 18 : 35; }
function addCheckpoint(list, id, name, coordinates, type, progress) {
  if (!Array.isArray(coordinates) || list.some((item) => item.id === id)) return;
  list.push({ id, name, coordinates, type, progress: Math.max(0, Math.min(1, progress)) });
}
function mergeCoordinates(parts) {
  const output = [];
  for (const part of parts) for (const point of part) {
    if (!output.length || output.at(-1)[0] !== point[0] || output.at(-1)[1] !== point[1]) output.push(point);
  }
  return output;
}
function smooth(points, steps) {
  if (!points || points.length < 2) return points || [];
  const output = [];
  for (let index = 0; index < points.length - 1; index++) {
    const segment = greatCircle(points[index], points[index + 1], steps);
    if (index) segment.shift();
    output.push(...segment);
  }
  return output;
}
function greatCircle(a, b, steps) {
  const toRad = Math.PI / 180, toDeg = 180 / Math.PI;
  const lon1 = a[0] * toRad, lat1 = a[1] * toRad, lon2 = b[0] * toRad, lat2 = b[1] * toRad;
  const angle = Math.acos(Math.max(-1, Math.min(1, Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1))));
  if (angle < .0001) return [a, b];
  const sin = Math.sin(angle), output = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, x = Math.sin((1 - t) * angle) / sin, y = Math.sin(t * angle) / sin;
    const px = x * Math.cos(lat1) * Math.cos(lon1) + y * Math.cos(lat2) * Math.cos(lon2);
    const py = x * Math.cos(lat1) * Math.sin(lon1) + y * Math.cos(lat2) * Math.sin(lon2);
    const pz = x * Math.sin(lat1) + y * Math.sin(lat2);
    output.push([Math.atan2(py, px) * toDeg, Math.atan2(pz, Math.sqrt(px * px + py * py)) * toDeg]);
  }
  return output;
}
function haversine(a, b) {
  const rad = Math.PI / 180, dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}
function routeDistance(route) { return route.slice(1).reduce((sum, point, index) => sum + haversine(route[index], point), 0); }
function nearestProjection(route, point) {
  let best = { distanceNm: Infinity, progress: 0, point: route[0] }, travelled = 0;
  const lengths = route.slice(1).map((value, index) => haversine(route[index], value));
  const total = lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], denominator = dx * dx + dy * dy;
    const t = denominator ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator)) : 0;
    const projected = [a[0] + t * dx, a[1] + t * dy], distanceNm = haversine(projected, point);
    if (distanceNm < best.distanceNm) best = { distanceNm, progress: total ? (travelled + lengths[i] * t) / total : 0, point: projected };
    travelled += lengths[i];
  }
  return best;
}

function status() { return { provider: 'Searoutes', configured: configured(), cacheTtlMs: TTL_MS }; }

module.exports = { getRoute, status };
