import { config } from './config.js';
import { createApp } from './app.js';

const { app } = createApp();

app.listen(config.port, () => {
  console.log(`stqry-dashboard listening on http://localhost:${config.port}`);
  if (config.useMockData) console.log(`[mock] ${config.mockReason}`);
  else console.log(`[ga] querying GA4 property ${config.propertyId} (${config.timeZone})`);
  console.log(
    config.cacheTtlMs > 0
      ? `[cache] results held for ${config.cacheTtlMinutes} minutes, refreshed only on request`
      : '[cache] disabled (CACHE_TTL_MINUTES=0): every request queries upstream',
  );
});
