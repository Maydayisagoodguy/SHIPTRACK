require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const aisClient = require('./tracking/aisClient');
const routes   = require('./tracking/routes');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve the frontend from /frontend folder
app.use(express.static(path.join(__dirname, '../../frontend')));

// All API routes under /api
app.use('/api', routes);

// Fallback: any non-API route serves the frontend SPA
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   HUMANITY ERP — Shipment Tracker    ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log(`  Server   → http://localhost:${PORT}`);
  console.log(`  API      → http://localhost:${PORT}/api/status`);
  console.log(`  Frontend → http://localhost:${PORT}`);
  console.log('');

  // Start AIS WebSocket (no-op if no API key set)
  aisClient.connect();
});
