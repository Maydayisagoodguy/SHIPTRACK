create extension if not exists postgis;

create table if not exists vessel_positions (
  id bigserial primary key,
  mmsi varchar(9) not null,
  observed_at timestamptz not null,
  position geography(point, 4326) not null,
  sog numeric,
  cog numeric,
  heading numeric,
  source text not null,
  source_type text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (mmsi, observed_at, source)
);
create index if not exists vessel_positions_mmsi_time on vessel_positions (mmsi, observed_at desc);
create index if not exists vessel_positions_geo on vessel_positions using gist (position);

create table if not exists shipment_routes (
  shipment_id text primary key,
  source text not null,
  generated_at timestamptz not null,
  geometry geometry(linestring, 4326) not null,
  distance_nm numeric,
  duration_ms bigint,
  checkpoints jsonb not null default '[]'::jsonb,
  raw jsonb not null default '{}'::jsonb
);
create index if not exists shipment_routes_geo on shipment_routes using gist (geometry);

create table if not exists tracking_events (
  id bigserial primary key,
  shipment_id text not null,
  mmsi varchar(9),
  event_type text not null,
  checkpoint_id text not null default '',
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  unique (shipment_id, event_type, checkpoint_id)
);
create index if not exists tracking_events_shipment_time on tracking_events (shipment_id, occurred_at desc);
