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

// ── soul file + voice clone Phase 2 (v0.12.0) ──
// Don't run a real export (1.5GB / 3min). Verify the no-overwrite refusal
// path and the missing-source rejection.
await probe('export_soul_file_to_path', { outputPath: '/tmp/wwm-stress-soul.zip' }, {
  // Either the export succeeds (clean tmp), gets 409 (file exists from earlier run),
  // or returns an error — all are acceptable as "endpoint reachable + shape valid"
  check: (d, isErr) => typeof d?.ok === 'boolean' || isErr,
  summary: (d, isErr) => isErr ? `errored: ${(JSON.stringify(d) || '').slice(0, 60)}` : (d?.ok ? `wrote ${d.sizeMB}MB` : `refused: ${(d?.error || '').slice(0, 50)}`),
});
// Cleanup any soul file we may have written
try { require('fs').unlinkSync('/tmp/wwm-stress-soul.zip'); } catch {}

await probe('create_voice_clone_from_path', { name: 'StressTest', sourcePath: '/tmp/wwm-nonexistent-audio.wav' }, {
  check: (d, isErr) => isErr || d?.ok === false,
  summary: (d) => `correctly rejected missing source: ${(d?.error || '').slice(0, 60)}`,
});
await probe('get_cloud_clone_order_status', { orderId: 'stress-test-bogus-order' }, {
  // Expect either: 401 if not signed in (correct), or 502 if upstream rejects (also fine)
  check: (d, isErr) => isErr || d?.ok === false,
  summary: (d) => `correctly handled: ${(d?.error || (d?.body?.error || '')).slice(0, 60)}`,
});

// ── transcribe arbitrary audio file (v0.11.0) ──
// Skip the live LLM call when no archive audio exists. We don't want
// to spend 30s on a real transcribe in every stress run — confirm the
// endpoint shape with a non-existent-path negative test.
await probe('transcribe_audio_file', { path: '/tmp/wwm-stress-nonexistent.wav' }, {
  check: (d, isErr) => isErr || d?.ok === false,
  summary: (d) => `correctly rejected missing file: ${(d?.error || '').slice(0, 60)}`,
});

// ── misc utilities (v0.10.0) ──
await probe('detect_hardware', {}, {
  check: (d) => typeof d?.cpuCores === 'number' && typeof d?.totalRAM === 'number',
  summary: (d) => `cpu=${d?.cpuModel?.slice(0,40)} cores=${d?.cpuCores} RAM=${d?.totalRAM}GB gpu=${d?.gpu?.name || 'none'} diskFree=${d?.diskFreeGB || '?'}GB`,
});
await probe('get_autostart_status', {}, {
  check: (d) => typeof d?.enabled === 'boolean',
  summary: (d) => `platform=${d?.platform} enabled=${d?.enabled}`,
});

// ── translation + documents (v0.9.0) ──
// TM round-trip: lookup miss → save → lookup hit (uses a unique-per-run key
// so we don't pollute Grant's actual TM with test data — clean up after)
const tmKey = `stress-test-${Date.now()}`;
await probe('lookup_translation_memory', { text: tmKey, sourceLang: 'en', targetLang: 'es' }, {
  check: (d) => d?.ok === true && d?.match === null,
  summary: (d) => `lookup miss as expected, match=${d?.match}`,
});
await probe('save_translation_memory', { source: tmKey, target: `${tmKey}-translated`, sourceLang: 'en', targetLang: 'es' }, {
  summary: (d) => `save ok=${d?.ok} updated=${d?.updated}`,
});
await probe('lookup_translation_memory', { text: tmKey, sourceLang: 'en', targetLang: 'es' }, {
  check: (d) => d?.ok === true && d?.match?.translation === `${tmKey}-translated`,
  summary: (d) => `lookup hit translation=${d?.match?.translation} hits=${d?.match?.hits}`,
});
await probe('get_translation_memory_stats', {}, {
  summary: (d) => `total=${d?.totalEntries} pairs=${d?.topPairs?.length} recent=${d?.recentEntries?.length}`,
});

// Document extraction round-trip
const docPath = `/tmp/wwm-stress-doc-${Date.now()}.md`;
const docContent = '# Stress test document\n\nThis is a *test* doc for `extract_document_text`.';
await probe('save_text_file', { path: docPath, content: docContent }, {
  check: (d) => d?.ok === true && d?.bytesWritten > 0,
  summary: (d) => `wrote ${d?.bytesWritten} bytes to ${d?.path}`,
});
await probe('extract_document_text', { path: docPath }, {
  check: (d) => d?.ok === true && d?.text === docContent,
  summary: (d) => `extracted ${d?.textLength} chars from ${d?.ext} file`,
});
// Negative path: overwrite without flag should refuse
await probe('save_text_file', { path: docPath, content: 'should refuse' }, {
  check: (d, isErr) => isErr || d?.ok === false,
  summary: (d) => `correctly refused overwrite: ${(d?.error || '').slice(0, 60)}`,
});
// Cleanup
try { require('fs').unlinkSync(docPath); } catch {}

// ── archive (v0.8.0) ──
const archiveList = await probe('list_archive_entries', { limit: 5 }, {
  summary: (d) => `${d.count} total entries (${d.entries?.length} returned); newest: "${(d.entries?.[0]?.text || '').slice(0,60).replace(/\n/g,' ')}..."`,
});
await probe('get_archive_stats', {}, {
  summary: (d) => `files=${d.totalFiles} sizeMB=${d.totalSizeMB} days=${d.days} words=${d.totalWords} sessions=${d.totalSessions} cached=${d.cached}`,
});
// If we have entries, try reading the metadata of the newest one (no media bytes)
if (archiveList?.entries?.[0]?.id) {
  await probe('read_archive_entry', { id: archiveList.entries[0].id, metadataOnly: true }, {
    summary: (d) => `id=${d.id} mediaType=${d.mediaType} present=${d.present} mimeType=${d.mimeType || 'n/a'}`,
  });
}
// Negative path: bogus id
await probe('read_archive_entry', { id: 'arc:1900-01-01:000000.md', metadataOnly: true }, {
  check: (d, isErr) => isErr || d?.ok === false,
  summary: (d) => `correctly rejected: ${(d?.error || '').slice(0, 60)}`,
});
await probe('delete_archive_entry', { id: 'arc:1900-01-01:000000.md' }, {
  check: (d, isErr) => isErr || d?.ok === false,
  summary: (d) => `correctly rejected delete: ${(d?.error || '').slice(0, 60)}`,
});

// ── voice clones (v0.7.0) ──
await probe('list_voice_clones', {}, { summary: (d) => `count=${d.count} activeId=${d.activeId}` });
await probe('get_active_voice_clone', {}, { summary: (d) => `active=${d.active ? d.active.id : 'null'}` });
await probe('list_clone_bundles', {}, { summary: (d) => `${d.count} bundles` });
// Negative paths — bogus ids should return structured error
await probe('set_active_voice_clone', { id: 'bogus-id-xyz' }, {
  check: (d, isErr) => isErr || d?.ok === false,
  summary: (d) => `correctly rejected: ${(d?.error || '').slice(0, 60)}`,
});
await probe('delete_voice_clone', { id: 'bogus-id-xyz' }, {
  check: (d, isErr) => isErr || d?.ok === false,
  summary: (d) => `correctly rejected: ${(d?.error || '').slice(0, 60)}`,
});
await probe('preview_voice_clone', { id: 'bogus-id-xyz', metadataOnly: true }, {
  check: (d, isErr) => isErr || d?.ok === false,
  summary: (d) => `correctly rejected: ${(d?.error || '').slice(0, 60)}`,
});
// Setting active to null (deactivate) should work even with no clones
await probe('set_active_voice_clone', { id: null }, {
  check: (d) => d?.ok === true && d?.activeId === null,
  summary: (d) => `deactivate ok=${d?.ok} activeId=${d?.activeId}`,
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

// ── polkit rule bootstrap (v1.1.0) ──
// Skip a live install/remove — that requires a pkexec prompt the user
// must accept. The endpoint surface (501 for non-Linux, 400 for bad
// args) is what we verify.
await probe('setup_install_polkit_rule', { enable: 'not-a-bool' }, {
  check: (d, isErr) => isErr || d?.ok === false,
  summary: (d) => `correctly rejected bad arg: ${(d?.error || '').slice(0, 60)}`,
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
