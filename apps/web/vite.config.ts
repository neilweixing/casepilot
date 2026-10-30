import { defineConfig, loadEnv } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'CASEPILOT_');
  const apiPort = Number(process.env.CASEPILOT_PORT || env.CASEPILOT_PORT || 4310);
  const webPort = apiPort + 1;
  return {
    server: { host: '127.0.0.1', port: webPort, strictPort: true, proxy: Object.fromEntries(['/api', '/demo', '/m1', '/health'].map(prefix => [prefix, {
      target: `http://127.0.0.1:${apiPort}`, changeOrigin: true,
      configure(proxy) { proxy.on('proxyReq', (proxyRequest, request) => { if (request.headers.origin === `http://127.0.0.1:${webPort}`) proxyRequest.setHeader('Origin', `http://127.0.0.1:${apiPort}`); }); },
    }])) },
  };
});
