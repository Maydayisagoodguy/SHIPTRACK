// In-memory store: MMSI → vessel state (latest AIS data)
const store = new Map();
const MAX = parseInt(process.env.MAX_VESSELS || '1000');

function update(mmsi, fields) {
  const existing = store.get(mmsi) || { mmsi };
  const next = { ...existing };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') next[k] = v;
  }
  next.last_seen = new Date().toISOString();
  store.set(mmsi, next);

  if (store.size > MAX) {
    // Evict least-recently-seen
    let oldest = null, oldestTime = Infinity;
    for (const [m, v] of store.entries()) {
      const t = new Date(v.last_seen || 0).getTime();
      if (t < oldestTime) { oldestTime = t; oldest = m; }
    }
    if (oldest) store.delete(oldest);
  }
}

function get(mmsi)  { return store.get(mmsi) || null; }
function getAll()   { return Array.from(store.values()); }
function size()     { return store.size; }
function clear(mmsi){ store.delete(mmsi); }

module.exports = { update, get, getAll, size, clear };
