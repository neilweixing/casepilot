import { loadConfig, redact } from './config.ts';
import { createServer } from './server.ts';
import { Store } from './storage.ts';

try {
  const config = loadConfig();
  const store = new Store(config.dataDir);
  const app = createServer(config, store);
  await app.listen({ host: config.host, port: config.port });
  console.log(`CasePilot 已启动：${config.origin}`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      // 先持久化中断和释放浏览器，再退出，避免 SDK 的后台句柄阻止 watch 接替。
      void app.close().then(() => process.exit(0), () => process.exit(1));
    });
  }
} catch (error) {
  console.error('CasePilot 启动失败：' + redact(error instanceof Error ? error.message : '请检查端口与本机数据目录权限', [process.env.CASEPILOT_API_KEY || '']));
  process.exitCode = 1;
}
