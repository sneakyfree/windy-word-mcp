// End-to-end demo: spawn the MCP server, call install_dependency via the
// proper agent path (MCP client → MCP server → HTTP → Windy Word → pkexec →
// polkit auto-approve → dnf install), verify wtype goes from missing to
// available, and that the paste-strategy chain reflects it.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, '..', 'bin', 'windy-word-mcp.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
});
const client = new Client({ name: 'install-demo', version: '0.0.0' });
await client.connect(transport);

const text = (r) => r.content?.[0]?.text || '(empty)';
const json = (r) => { try { return JSON.parse(text(r)); } catch { return text(r); } };

async function step(label, fn) {
  console.log(`\n━━ ${label} ━━`);
  const t0 = Date.now();
  try {
    const result = await fn();
    console.log(`(${Date.now() - t0}ms)`);
    if (result !== undefined) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    console.log(`✗ ${e.message}`);
    throw e;
  }
}

// 1. What can we install?
const caps = await step('list_installable_dependencies', async () => {
  const r = await client.callTool({ name: 'list_installable_dependencies', arguments: {} });
  return json(r);
});

// 2. Dry-run wtype install (no system mutation)
await step('install_dependency wtype (dryRun)', async () => {
  const r = await client.callTool({ name: 'install_dependency', arguments: { tool: 'wtype', dryRun: true } });
  return json(r);
});

// 3. Actual wtype install — polkit rule should auto-approve
const installResult = await step('install_dependency wtype (live)', async () => {
  const r = await client.callTool({ name: 'install_dependency', arguments: { tool: 'wtype' } });
  return json(r);
});

// 4. Verify wtype is now on PATH
await step('get_install_history', async () => {
  const r = await client.callTool({ name: 'get_install_history', arguments: { limit: 5 } });
  return json(r);
});

// 5. Confirm paste-strategy registry sees wtype now
const strategies = await step('list_paste_strategies (post-install)', async () => {
  const r = await client.callTool({ name: 'list_paste_strategies', arguments: {} });
  return json(r);
});

const wtypeEntry = strategies?.strategies?.find((s) => s.name === 'wtype');
const chain = strategies?.defaultChain;
console.log(`\n━━ summary ━━`);
console.log(`install ok: ${installResult?.ok}`);
console.log(`install elapsed: ${installResult?.elapsedMs}ms`);
console.log(`install exitCode: ${installResult?.exitCode}`);
console.log(`wtype availableOnThisMachine: ${wtypeEntry?.availableOnThisMachine}`);
console.log(`resolved chain (first 3): ${(chain || []).slice(0, 3).join(' → ')}`);

await client.close();
process.exit(installResult?.ok && wtypeEntry?.availableOnThisMachine ? 0 : 1);
