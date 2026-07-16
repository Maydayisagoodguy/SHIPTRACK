# Shipment Tracker Trial Setup

The application runs without paid credentials using AISstream and prototype routes. Trial credentials activate the production provider adapters automatically.

## 1. Spire Maritime

Request a Maritime 2.0 trial token and add these values to `backend/.env`:

```env
SPIRE_API_TOKEN=your_trial_token
SPIRE_API_URL=https://api.spire.com/graphql
SPIRE_POLL_MS=300000
```

Restart the backend. `GET /api/status` should show the Spire provider as configured. After the first successful poll it will show as connected.

## 2. Searoutes

Request an Ocean Routing trial key and add it to `backend/.env`:

```env
SEAROUTES_API_KEY=your_trial_key
SEAROUTES_ROUTE_TTL_MS=86400000
```

Restart the backend. Existing prototype routes are replaced automatically on the next route request. To force regeneration, call:

```text
GET /api/route/{shipmentId}?refresh=true
```

## 3. PostgreSQL/PostGIS (Optional For Trial)

Create a PostgreSQL database with PostGIS, run `backend/migrations/001_tracking.sql`, and add:

```env
DATABASE_URL=postgresql://user:password@host:5432/shipment_tracker
DATABASE_SSL=true
```

Without `DATABASE_URL`, the prototype continues using local JSON and in-memory stores.

## Verification

Open `GET /api/status` and confirm:

- `providers[].configured` is `true` for Spire.
- `providers[].connected` becomes `true` after a successful poll.
- `routing.configured` is `true` for Searoutes.
- `database.connected` is `true` when PostGIS is enabled.

Provider secrets stay in `backend/.env` and must never be placed in frontend code.
