import { McpClient } from '@earendil-works/pi-mcp';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { browserTools, browserTransport, processExists } from './mcp.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const directory = path.join(config.dataDir, 'mcp-check');
const transport = browserTransport(directory, config.origin);
const client = new McpClient({ name: 'casepilot-preflight', version: '0.0.0', requestTimeoutMs: 10000 });
let pid: number | undefined;
try {
  await client.connect(transport);
  pid = transport.pid;
  const tools = await client.listTools();
  const missing = browserTools.filter(name => !tools.some(tool => tool.name === name));
  if (missing.length) throw new Error(`MCP 缺少工具：${missing.join('、')}`);
  writeFileSync(path.join(directory, 'inventory.json'), JSON.stringify({ server: client.serverInfo, protocol: client.protocolVersion, tools }, null, 2), { mode: 0o600 });
  console.log(`真实 MCP 已连接，发现 ${tools.length} 个工具，M1 所需工具齐全。清单：data/mcp-check/inventory.json`);
} catch {
  console.error('MCP 预检查失败，请检查精确依赖安装；此检查未调用模型或打开浏览器。');
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
  if (processExists(pid)) { console.error('MCP 子进程未释放'); process.exitCode = 1; }
  else console.log('MCP 子进程已释放。');
}
