const fs = require('fs');
const path = require('path');
const database = require('../persistence/database');

const FILE = path.join(__dirname, '../../data/tracking-events.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return []; }
}

function add(event) {
  const events = read();
  const exists = events.some((item) => item.shipmentId === event.shipmentId &&
    item.type === event.type && item.checkpointId === event.checkpointId);
  if (exists) return false;
  events.push(event);
  fs.writeFileSync(FILE, JSON.stringify(events.slice(-5000), null, 2), 'utf8');
  database.saveEvent(event);
  return true;
}

function forShipment(shipmentId) {
  return read().filter((event) => event.shipmentId === shipmentId)
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
}

module.exports = { add, forShipment };
