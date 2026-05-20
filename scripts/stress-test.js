// Stress test: exercise every safe MCP tool via the full agent path and
// report on each. Tools that would mutate visible UI state, inject keystrokes,
// or hot-reload the engine are noted but skipped — they're tested separately
// during normal use.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, '..', 'bin', 'windy-word-mcp.js');

const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry] });
const client = new Client({ name: 'stress-test', version: '0.0.0' });
await client.connect(transport);

const json = (r) => { try { return JSON.parse(r.content?.[0]?.text || 'null'); } catch { return r.content?.[0]?.text; } };
const results = [];

async function probe(name, args = {}, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await client.callTool({ name, arguments: args });
    const data = json(r);
    const ms = Date.now() - t0;
    const ok = !r.isError && (opts.check ? opts.check(data) : true);
    results.push({ tool: name, args, ok, ms, summary: opts.summary?.(data) ?? '(no summary)' });
    return data;
  } catch (e) {
    results.push({ tool: name, args, ok: false, ms: Date.now() - t0, summary: `THREW: ${e.message}` });
    return null;
  }
}

// ── Safe read-only / state-only ──
await probe('get_platform', {}, { summary: (d) => `${d.distro} ${d.distroVersion}, ${d.displayServer}/${d.desktop}, xdotool=${d.hasXdotool} ydotool=${d.hasYdotool}` });
await probe('list_paste_strategies', {}, {
  summary: (d) => `${d.strategies.length} strategies, ${d.strategies.filter(s => s.availableOnThisMachine).length} available; chain=${d.defaultChain.slice(0,3).join('→')}; collision=${d.hotkeyCollisionDetected}`,
});
await probe('get_active_paste_strategy', {}, { summary: (d) => `strategy=${d.strategy}, resolved=${d.resolvedChain?.slice(0,3).join('→')}` });
await probe('get_paste_target', {}, { summary: (d) => `target=${d.targetType}` });
await probe('get_paste_history', { limit: 5 }, { summary: (d) => `${d.count} entries` });
await probe('list_hotkeys', {}, { summary: (d) => `${Object.keys(d.bindings || {}).length} bindings; available=${(d.available || []).join(',')}` });
await probe('list_models', {}, { summary: (d) => `current=${d.current}, ladder=${(d.ladder || []).join(',')}` });
await probe('get_windytune_state', {}, { summary: (d) => `enabled=${d.enabled}, model=${d.currentModel}, history=${d.historyCount}, avgRatio=${d.recentAvgRatio}` });
await probe('get_config', {}, { summary: (d) => `${Object.keys(d || {}).length} top-level keys: ${Object.keys(d || {}).slice(0,6).join(',')}…` });

// ── install_dependency surface ──
await probe('list_installable_dependencies', {}, { summary: (d) => `supported=${d.supported} distro=${d.distro} tools=${d.tools?.map(t=>t.name).join(',')}` });
await probe('install_dependency', { tool: 'wtype', dryRun: true }, { summary: (d) => `dryRun cmd: ${d.command}` });
await probe('install_dependency', { tool: 'wl-clipboard' }, { summary: (d) => `alreadyInstalled=${d.alreadyInstalled} ok=${d.ok}` });
await probe('install_dependency', { tool: 'xdotool' }, { summary: (d) => `alreadyInstalled=${d.alreadyInstalled} ok=${d.ok}` });
await probe('install_dependency', { tool: 'ydotool' }, { summary: (d) => `alreadyInstalled=${d.alreadyInstalled} ok=${d.ok}` });
await probe('get_install_history', { limit: 10 }, { summary: (d) => `${d.history?.length} entries; tools=${d.history?.map(h=>h.tool).join(',')}` });

// ── invariant: whitelist rejects garbage ──
// (zod enum should reject at the MCP layer before it even hits Windy Word)
const garbage = await client.callTool({ name: 'install_dependency', arguments: { tool: 'curl; rm -rf /' } }).catch(e => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
results.push({
  tool: 'install_dependency',
  args: { tool: 'curl; rm -rf /' },
  ok: !!garbage.isError,
  ms: 0,
  summary: garbage.isError ? `rejected at MCP zod layer ✓` : 'NOT REJECTED — security regression',
});

// ── empty / invalid input ──
const noTool = await client.callTool({ name: 'install_dependency', arguments: {} }).catch(e => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
results.push({
  tool: 'install_dependency',
  args: {},
  ok: !!noTool.isError,
  ms: 0,
  summary: noTool.isError ? `rejected missing tool ✓` : 'NOT REJECTED — schema validation gap',
});

// ── set_paste_strategy auto (idempotent, no harm) ──
await probe('set_paste_strategy', { strategy: 'auto' }, { summary: (d) => `set ok=${d.ok}, strategy=${d.strategy}` });

// ── audit-log clears ──
await probe('clear_install_history', {}, { summary: (d) => `cleared ok=${d.ok}` });
await probe('clear_paste_history', {}, { summary: (d) => `cleared ok=${d.ok}` });

// ── concurrency burst ──
const burstStart = Date.now();
const bursts = await Promise.all(Array.from({ length: 20 }, () =>
  client.callTool({ name: 'get_platform', arguments: {} })
));
const burstOk = bursts.every(r => !r.isError);
results.push({
  tool: 'get_platform x 20 in parallel',
  args: 'concurrency burst',
  ok: burstOk,
  ms: Date.now() - burstStart,
  summary: burstOk ? `all 20 responded in ${Date.now() - burstStart}ms` : 'one or more failed under concurrency',
});

await client.close();

// ── report ──
console.log('\n┌─ Stress test results ─────────────────────────────────────────────────────────────────────────────┐');
for (const r of results) {
  const status = r.ok ? '✓' : '✗';
  const ms = String(r.ms).padStart(6);
  const tool = r.tool.padEnd(38);
  console.log(`│ ${status}  ${tool} ${ms}ms  ${r.summary}`);
}
const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log(`└─ ${pass}/${results.length} passed, ${fail} failed ─────────────────────────────────────────────────────────────────────────┘\n`);
process.exit(fail === 0 ? 0 : 1);
