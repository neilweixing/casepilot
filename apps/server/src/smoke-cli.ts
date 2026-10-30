import { loadConfig, loadModelConfig, redact } from './config.ts';
import { runSmoke } from './smoke.ts';

const controller = new AbortController();
if (process.send) process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'casepilot-stop') controller.abort(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
let secrets: string[] = [];
try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--variant=normal', '--variant=reversed'].includes(arg)) || args.length > 1) throw new Error('用法：pnpm smoke [--variant=normal|--variant=reversed]');
  const model = loadModelConfig();
  secrets = [model.apiKey];
  const variant = args.includes('--variant=reversed') ? 'reversed' : 'normal';
  const { result, directory } = await runSmoke(loadConfig(), model, variant, controller.signal);
  console.log(`结果：${result.status}；证据：${directory}`);
  for (const error of result.errors) console.error(error);
  // 失败样本仍返回非零，避免把测试预期失败与业务通过混为一谈。
  if (result.status !== 'PASSED') process.exitCode = result.status === 'FAILED' ? 2 : 1;
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : 'M1 执行异常', secrets));
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
