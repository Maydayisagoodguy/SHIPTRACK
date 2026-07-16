// Simple file-based store — no external DB required
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/shipments.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function write(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
}

function getAll()   { return read(); }

function getById(id) {
  return read().find(s => s.id === id) || null;
}

function add(shipment) {
  const list = read();
  const id = 'SHP-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-4);
  const entry = { id, created_at: new Date().toISOString().slice(0,10), ...shipment };
  list.push(entry);
  write(list);
  return entry;
}

function remove(id) {
  const list = read().filter(s => s.id !== id);
  write(list);
}

function getTrackedMMSIs() {
  return read().map(s => s.mmsi).filter(Boolean);
}

module.exports = { getAll, getById, add, remove, getTrackedMMSIs };
