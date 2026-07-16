// In-memory store: MMSI -> latest normalized vessel state.
const store = new Map();
const tracks = new Map();
const database = require('../persistence/database');
const MAX = parseInt(process.env.MAX_VESSELS || '1000', 10);
const MAX_TRACK_POINTS = parseInt(process.env.MAX_TRACK_POINTS || '720', 10);

function update(mmsi, fields) {
  const existing = store.get(mmsi) || { mmsi };
  const next = { ...existing };
  const incomingTime = fields.position_at ? new Date(fields.position_at).getTime() : null;
  const existingTime = existing.position_at ? new Date(existing.position_at).getTime() : null;
  const stalePosition = Number.isFinite(incomingTime) && Number.isFinite(existingTime) && incomingTime < existingTime;
  const positionalFields = new Set([
    'latitude', 'longitude', 'sog', 'cog', 'true_heading', 'nav_status',
    'position_at', 'source', 'source_type', 'accuracy',
  ]);

  for (const [key, value] of Object.entries(fields)) {
    if (stalePosition && positionalFields.has(key)) continue;
    if (value !== undefined && value !== null && value !== '') next[key] = value;
  }

  next.received_at = new Date().toISOString();
  store.set(mmsi, next);

  if (!stalePosition && Number.isFinite(fields.latitude) && Number.isFinite(fields.longitude) && fields.position_at) {
    const track = tracks.get(mmsi) || [];
    const previous = track[track.length - 1];
    if (!previous || previous.position_at !== fields.position_at) {
      track.push({
        latitude: fields.latitude,
        longitude: fields.longitude,
        position_at: fields.position_at,
        sog: fields.sog ?? null,
        cog: fields.cog ?? null,
      });
      if (track.length > MAX_TRACK_POINTS) track.splice(0, track.length - MAX_TRACK_POINTS);
      tracks.set(mmsi, track);
    }
    database.savePosition({ ...next, ...fields });
  }

  if (store.size > MAX) {
    let oldest = null;
    let oldestTime = Infinity;
    for (const [key, vessel] of store.entries()) {
      const time = new Date(vessel.received_at || 0).getTime();
      if (time < oldestTime) {
        oldestTime = time;
        oldest = key;
      }
    }
    if (oldest) store.delete(oldest);
  }
}

function quality(vessel) {
  if (!vessel || !vessel.position_at) {
    return { state: 'no_signal', ageSeconds: null, isLive: false };
  }

  const observed = new Date(vessel.position_at).getTime();
  const ageSeconds = Number.isFinite(observed)
    ? Math.max(0, Math.floor((Date.now() - observed) / 1000))
    : null;

  if (ageSeconds === null) return { state: 'no_signal', ageSeconds: null, isLive: false };
  if (ageSeconds <= 15 * 60) return { state: 'live', ageSeconds, isLive: true };
  if (ageSeconds <= 6 * 60 * 60) return { state: 'recent', ageSeconds, isLive: false };
  return { state: 'stale', ageSeconds, isLive: false };
}

function get(mmsi) { return store.get(mmsi) || null; }
function getAll() { return Array.from(store.values()); }
function size() { return store.size; }
function clear(mmsi) { store.delete(mmsi); }
function getTrack(mmsi) { return tracks.get(mmsi) || []; }

module.exports = { update, quality, get, getAll, getTrack, size, clear };
