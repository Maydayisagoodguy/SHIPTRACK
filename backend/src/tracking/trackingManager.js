const aisClient = require('./aisClient');
const spireClient = require('./providers/spireClient');

function start() {
  aisClient.connect();
  spireClient.start();
}

function refresh() {
  aisClient.refreshSubscription();
  spireClient.refresh();
}

function status() {
  const providers = [spireClient.status(), aisClient.status()];
  const primary = providers.find((item) => item.provider === 'Spire' && item.configured) || providers[1];
  return {
    ...primary,
    providers,
    provider: primary.provider,
    connected: providers.some((item) => item.connected),
  };
}

module.exports = { start, refresh, status };
