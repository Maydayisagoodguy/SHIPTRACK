// Manages all active SSE browser connections
const clients = new Set();

function add(res) {
  clients.add(res);
  console.log(`[SSE] Client connected. Total: ${clients.size}`);
  res.on('close', () => {
    clients.delete(res);
    console.log(`[SSE] Client disconnected. Total: ${clients.size}`);
  });
}

function broadcast(payload) {
  if (clients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try { client.write(data); }
    catch { clients.delete(client); }
  }
}

function count() { return clients.size; }

module.exports = { add, broadcast, count };
