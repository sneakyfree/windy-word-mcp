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
    // For a tool result, "ok" can mean two different things:
    //   - opts.check provided  → use it (it gets the parsed data + isError flag)
    //   - no check             → tool succeeded if isError is false
    const ok = opts.check ? opts.check(data, r.isError) : !r.isError;
    results.push({ tool: name, args, ok, ms, summary: opts.summary?.(data, r.isError) ?? '(no summary)' });
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

// ── settings catalog (v0.3.0 + tag filter v0.6.0) ──
await probe('list_settings', {}, { summary: (d) => `${d.count} catalog entries; tags=${(d.availableTags||[]).join(',')}` });
await probe('list_settings', { tag: 'voice-clone' }, {
  check: (d) => d.count > 0 && d.settings.every(s => (s.tags||[]).includes('voice-clone')),
  summary: (d) => `voice-clone tag: ${d.count} settings — ${d.settings?.map(s=>s.path).join(', ')}`,
});
await probe('list_settings', { tag: 'nonexistent-tag' }, {
  check: (d) => d.count === 0,
  summary: (d) => `nonexistent tag: ${d.count} entries (correct)`,
});
await probe('describe_setting', { path: 'engine.model' }, { summary: (d) => `${d.path} type=${d.type} current=${JSON.stringify(d.currentValue)} enum=${d.enum?.join(',')}` });
await probe('describe_setting', { path: 'bogus.path' }, {
  check: (d) => d?.error?.includes('not in catalog'),
  summary: (d) => d?.error ? `correctly 404'd: ${d.error.slice(0, 60)}` : `should have errored`,
});

// validate-and-apply happy path: bounce engine.model to 'small' (idempotent — already 'small')
await probe('set_setting', { path: 'engine.model', value: 'small' }, {
  summary: (d) => `ok=${d.ok} previous=${JSON.stringify(d.previousValue)} side=${(d.sideEffects||[]).join('; ')}`,
});

// validation failures (each should return ok=false with a useful error)
await probe('set_setting', { path: 'engine.model', value: 'tinyy' }, {
  check: (d) => d?.ok === false && d?.error?.includes('must be one of'),
  summary: (d) => `correctly rejected: ${d?.error?.slice(0,60)}`,
});
await probe('set_setting', { path: 'appearance.opacity', value: 5 }, {
  check: (d) => d?.ok === false && d?.error?.includes('≤'),
  summary: (d) => `correctly rejected: ${d?.error?.slice(0,60)}`,
});
await probe('set_setting', { path: 'hotkeys.toggleRecording', value: 'lol+bogus' }, {
  check: (d) => d?.ok === false && d?.error?.toLowerCase().includes('accelerator'),
  summary: (d) => `correctly rejected: ${d?.error?.slice(0,60)}`,
});
await probe('set_setting', { path: 'license.tier', value: 'pro' }, {
  check: (d) => d?.ok === false && d?.error?.includes('read-only'),
  summary: (d) => `correctly rejected readonly: ${d?.error?.slice(0,60)}`,
});
await probe('set_setting', { path: 'nonexistent.setting', value: true }, {
  check: (d) => d?.ok === false && d?.error?.includes('unknown'),
  summary: (d) => `correctly rejected unknown: ${d?.error?.slice(0,60)}`,
});

// ── async install (v0.4.0) ──
const asyncJob = await probe('install_dependency_async', { tool: 'wtype' }, { summary: (d) => `jobId=${d.jobId} status=${d.status}` });
if (asyncJob?.jobId) {
  await new Promise((r) => setTimeout(r, 50));
  await probe('get_install_status', { jobId: asyncJob.jobId }, { summary: (d) => `status=${d.status} result.ok=${d.result?.ok}` });
}
await probe('list_install_jobs', {}, { summary: (d) => `${d.jobs?.length} jobs in memory` });
await probe('get_install_status', { jobId: 'install-9999999-fake' }, {
  check: (d, isErr) => isErr || d?.error?.includes('not found'),
  summary: (d, isErr) => isErr ? 'correctly 404\'d on unknown jobId' : (d?.error || 'NOT REJECTED'),
});

// ── doctor (v0.4.0) ──
await probe('list_diagnostic_checks', {}, { summary: (d) => `${d.checks?.length} checks defined; ${d.checks?.filter(c => c.appliesToCurrentPlatform).length} apply to this platform` });
const diag = await probe('run_diagnostics', {}, { summary: (d) => `overall=${d.overall}; counts=${JSON.stringify(d.counts)}; actionable=${d.actionable?.length}` });

// ── cloud relay (v0.5.0) — costs ~$0.002 per call, may fail on credit-out ──
const cloudResult = await probe('cloud_diagnose', {}, {
  // Pass if either the LLM call succeeded OR the failure is the OpenRouter
  // credit-out path (the auth + relay routing is what we're testing here).
  check: (d) => d?.ok === true || (d?.cloud?.error === 'openrouter upstream failed' && d?.cloud?.status === 402),
  summary: (d) => d?.cloud?.ok
    ? `relay model=${d?.cloud?.meta?.model} elapsed=${d?.cloud?.meta?.elapsedMs}ms cost=$${d?.cloud?.meta?.usage?.cost?.toFixed(4)}`
    : d?.cloud?.status === 402 ? 'relay reachable, OpenRouter out of credits (top up to re-enable)'
    : `cloud failed: ${JSON.stringify(d?.cloud).slice(0, 100)}`,
});

// ── real paste injection (v0.6.0) — actually injects keystrokes ──
await probe('run_paste_injection_test', { strategy: 'ydotool_type', text: 'STRESS-TEST-INJECT' }, {
  check: (d) => d?.ok === true && d?.match === true,
  summary: (d) => d?.ok ? `match=${d.match} captured="${d.captured}" focusedDuringSpawn=${d.focusedWindowDuringSpawn}` : `INJECTED but did not match: captured="${d?.captured}"`,
});

// ── cross-platform whitelist sanity (v0.4.0) ──
await probe('list_installable_dependencies', {}, {
  check: (d) => d.tools && d.tools.length >= 5,
  summary: (d) => `os=${d.os} pm=${d.packageManager} tools=${(d.tools||[]).map(t=>t.name).join(',')}`,
});
await probe('install_dependency', { tool: 'cliclick', dryRun: true }, {
  // cliclick is macOS-only — Linux should reject as "not installable on linux/fedora"
  check: (d, isErr) => isErr || d?.ok === false,
  summary: (d, isErr) => isErr ? `correctly rejected: ${d?.error || ''}`.slice(0,80) : `unexpected ok=${d?.ok}`,
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
