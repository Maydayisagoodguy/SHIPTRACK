let pool = null;
let ready = false;

async function init() {
  if (!process.env.DATABASE_URL) {
    console.log('[DB] DATABASE_URL not set; using local prototype stores.');
    return false;
  }

  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
    await pool.query('select 1');
    ready = true;
    console.log('[DB] PostgreSQL connected.');
  } catch (error) {
    console.error('[DB] PostgreSQL unavailable:', error.message);
    pool = null;
    ready = false;
  }
  return ready;
}

async function savePosition(vessel) {
  if (!ready || !vessel?.position_at) return;
  try {
    await pool.query(`
      insert into vessel_positions
        (mmsi, observed_at, position, sog, cog, heading, source, source_type, raw)
      values ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $7, $8, $9, $10)
      on conflict (mmsi, observed_at, source) do nothing
    `, [
      vessel.mmsi, vessel.position_at, vessel.longitude, vessel.latitude,
      vessel.sog, vessel.cog, vessel.true_heading, vessel.source,
      vessel.source_type, JSON.stringify(vessel),
    ]);
  } catch (error) {
    console.error('[DB] Position write failed:', error.message);
  }
}

async function saveRoute(shipmentId, route) {
  if (!ready || !route?.geometry) return;
  try {
    await pool.query(`
      insert into shipment_routes
        (shipment_id, source, generated_at, geometry, distance_nm, duration_ms, checkpoints, raw)
      values ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), $5, $6, $7, $8)
      on conflict (shipment_id) do update set
        source=excluded.source, generated_at=excluded.generated_at,
        geometry=excluded.geometry, distance_nm=excluded.distance_nm,
        duration_ms=excluded.duration_ms, checkpoints=excluded.checkpoints, raw=excluded.raw
    `, [
      shipmentId, route.source, route.generatedAt, JSON.stringify(route.geometry),
      route.distanceNm, route.durationMs, JSON.stringify(route.checkpoints), JSON.stringify(route),
    ]);
  } catch (error) {
    console.error('[DB] Route write failed:', error.message);
  }
}

async function saveEvent(event) {
  if (!ready) return;
  try {
    await pool.query(`
      insert into tracking_events
        (shipment_id, mmsi, event_type, checkpoint_id, occurred_at, payload)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (shipment_id, event_type, checkpoint_id) do nothing
    `, [event.shipmentId, event.mmsi, event.type, event.checkpointId, event.occurredAt, JSON.stringify(event)]);
  } catch (error) {
    console.error('[DB] Event write failed:', error.message);
  }
}

function status() {
  return { configured: Boolean(process.env.DATABASE_URL), connected: ready, driver: ready ? 'postgres-postgis' : 'local' };
}

module.exports = { init, savePosition, saveRoute, saveEvent, status };
