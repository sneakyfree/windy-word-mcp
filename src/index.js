// Windy Word MCP server — exposes the Windy Word control surface
// (paste strategies, hotkeys, transcription models, config, actions)
// as MCP tools. All tools are thin wrappers over HTTP endpoints on
// 127.0.0.1:18765 served by the running Windy Word desktop app.
//
// See README.md for the full tool catalog and install instructions.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { apiGet, apiPost, describeServer, WindyWordClientError } from './client.js';

const SERVER_VERSION = '0.5.0';

const server = new McpServer({
  name: 'windy-word',
  version: SERVER_VERSION,
});

// ── helpers ──────────────────────────────────────────────────────────────

function ok(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

function err(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// Wrap a handler so WindyWordClientError surfaces cleanly to the agent.
//
// Two cases worth distinguishing:
//
//   1. Connection / timeout error (no body)         → return the message text
//      so the agent sees "Windy Word is not running" or similar.
//   2. HTTP 4xx with a structured JSON error body   → return the parsed body
//      so the agent can inspect `ok: false`, `error: "..."`, etc. This is
//      the normal path for validation failures (set_setting with a bad value,
//      install_dependency with a non-whitelisted tool that bypassed zod,
//      describe_setting on an unknown path) — the agent SHOULD be able to
//      act on those structurally, not parse them out of a string.
function wrap(handler) {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (e) {
      if (e instanceof WindyWordClientError) {
        if (e.body) {
          try {
            const parsed = JSON.parse(e.body);
            return { isError: true, content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }] };
          } catch { /* body wasn't JSON; fall through to plain-text error */ }
        }
        return err(e.message);
      }
      throw e;
    }
  };
}

// ── platform ─────────────────────────────────────────────────────────────

server.registerTool(
  'get_platform',
  {
    description:
      'Return OS / arch / distro / display-server / desktop-environment / tool-availability ' +
      'info for the machine running Windy Word. Use this first when diagnosing paste / hotkey ' +
      'issues — the platform determines which strategies and capabilities are valid.',
  },
  wrap(async () => ok(await apiGet('/platform'))),
);

// ── paste strategies ─────────────────────────────────────────────────────

server.registerTool(
  'list_paste_strategies',
  {
    description:
      'List all 12 paste strategies (macOS / Windows / Linux X11 / Linux Wayland) with full ' +
      'capability metadata, a per-strategy availableOnThisMachine flag, the resolved default ' +
      'fallback chain, and a hotkeyCollisionDetected flag indicating whether Mutter or another ' +
      'compositor is eating Windy Word\'s own paste keystroke (which silently breaks the ' +
      'Ctrl+Shift+V family on Wayland+GNOME).',
  },
  wrap(async () => ok(await apiGet('/paste/strategies'))),
);

server.registerTool(
  'get_active_paste_strategy',
  {
    description:
      'Return the currently selected paste strategy, the user-configured fallback chain, and ' +
      'the resolved chain that will actually be tried at paste time. When strategy is "auto", ' +
      'the chain comes from defaultFallbackChain() with hotkey-collision demotion applied.',
  },
  wrap(async () => ok(await apiGet('/paste/active'))),
);

server.registerTool(
  'set_paste_strategy',
  {
    description:
      'Select a paste strategy. Pass "auto" to use the platform default chain, or a specific ' +
      'strategy name (e.g. "wtype", "ydotool_type", "osascript_cmdv"). Optionally override the ' +
      'fallback chain. Strategy names come from list_paste_strategies.',
    inputSchema: {
      strategy: z
        .string()
        .describe('Strategy name (or "auto"). Must match a name returned by list_paste_strategies.'),
      fallbackChain: z
        .array(z.string())
        .optional()
        .describe('Optional override for the fallback order. If omitted, leaves the existing chain.'),
    },
  },
  wrap(async ({ strategy, fallbackChain }) =>
    ok(await apiPost('/paste/select', { strategy, ...(fallbackChain ? { fallbackChain } : {}) })),
  ),
);

server.registerTool(
  'test_paste_strategy',
  {
    description:
      'WARNING: injects test text ("wtest") into whatever window currently has focus. ' +
      'Use to verify a specific strategy works on this machine. Returns timing + success flag. ' +
      'Have the user focus a known-safe target (e.g. a text editor) before calling.',
    inputSchema: {
      strategy: z.string().describe('Strategy name to test. Get the list from list_paste_strategies.'),
    },
  },
  wrap(async ({ strategy }) => ok(await apiPost('/paste/test', { strategy }))),
);

server.registerTool(
  'auto_paste',
  {
    description:
      'Execute the auto-paste flow against an explicit candidate chain. Returns the winning ' +
      'strategy + per-strategy diagnostic data. Useful for stress-testing fallback behavior. ' +
      'WARNING: injects text into the focused window.',
    inputSchema: {
      candidates: z
        .array(z.string())
        .optional()
        .describe('Ordered list of strategies to try. Defaults to defaultFallbackChain().'),
      text: z.string().optional().describe('Text to paste (defaults to "wtest").'),
    },
  },
  wrap(async ({ candidates, text }) => {
    const body = {};
    if (candidates) body.candidates = candidates;
    if (text !== undefined) body.text = text;
    return ok(await apiPost('/paste/auto', body));
  }),
);

server.registerTool(
  'get_paste_history',
  {
    description:
      'Return the last N paste attempts with diagnostic data: timestamp, text length, content ' +
      'hash (NOT the actual text), strategy chain attempted, winner, target window type. The ' +
      'buffer is in-memory and resets when the app restarts.',
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe('Max entries to return (default 20).'),
    },
  },
  wrap(async ({ limit }) => {
    const qs = limit !== undefined ? `?limit=${limit}` : '';
    return ok(await apiGet(`/paste/history${qs}`));
  }),
);

server.registerTool(
  'clear_paste_history',
  {
    description: 'Reset the in-memory paste history buffer. Useful between stress-test runs.',
  },
  wrap(async () => ok(await apiPost('/paste/history/clear'))),
);

server.registerTool(
  'get_paste_target',
  {
    description:
      'Detect whether the currently focused window is XWayland or Wayland-native (or unknown). ' +
      'This is what xdotool sees — agents use it to verify their assumptions before picking a ' +
      'strategy, because XWayland targets accept different keystrokes than Wayland-native ones.',
  },
  wrap(async () => ok(await apiGet('/paste/target'))),
);

// ── hotkeys ──────────────────────────────────────────────────────────────

server.registerTool(
  'list_hotkeys',
  {
    description:
      'List all current keyboard shortcut bindings, the set of rebindable actions, and the ' +
      'list of accelerators that are reserved (cannot be assigned). Use this before set_hotkey.',
  },
  wrap(async () => ok(await apiGet('/hotkeys'))),
);

server.registerTool(
  'set_hotkey',
  {
    description:
      'Rebind a keyboard shortcut. Action keys: toggleRecording, pasteTranscript, ' +
      'pasteClipboard, showHide, quickTranslate. Accelerator format is Electron-style ' +
      '(e.g. "CommandOrControl+Shift+Space", "Alt+W"). Triggers an immediate re-registration.',
    inputSchema: {
      key: z
        .enum(['toggleRecording', 'pasteTranscript', 'pasteClipboard', 'showHide', 'quickTranslate'])
        .describe('Which action to rebind.'),
      accelerator: z
        .string()
        .describe('Electron accelerator (e.g. "CommandOrControl+Shift+Space"). Avoid reserved combos.'),
    },
  },
  wrap(async ({ key, accelerator }) => ok(await apiPost('/hotkeys', { key, accelerator }))),
);

// ── models + transcription engine ────────────────────────────────────────

server.registerTool(
  'list_models',
  {
    description:
      'List available Whisper transcription models (tiny / base / small / medium / large-v3), ' +
      'their on-disk size and accuracy/speed tradeoff, the current selected model, and the ' +
      'WindyTune ladder.',
  },
  wrap(async () => ok(await apiGet('/models'))),
);

server.registerTool(
  'set_model',
  {
    description:
      'Switch the active transcription model. Hot-reloads the running Python engine over ' +
      'WebSocket if it is currently active — no app restart needed. Model must be in the ' +
      'WindyTune ladder (see list_models).',
    inputSchema: {
      model: z.string().describe('Model id (e.g. "tiny", "base", "small", "medium", "large-v3").'),
    },
  },
  wrap(async ({ model }) => ok(await apiPost('/models', { model }))),
);

server.registerTool(
  'get_windytune_state',
  {
    description:
      'Return WindyTune auto-tune state: whether it is enabled, the current model, the model ' +
      'ladder, switch thresholds, the recent transcription timing history, and the rolling ' +
      'average ratio (used to decide when to climb or descend the ladder).',
  },
  wrap(async () => ok(await apiGet('/windytune/state'))),
);

// ── install_dependency (Linux-only v0) ───────────────────────────────────

server.registerTool(
  'list_installable_dependencies',
  {
    description:
      'List the whitelisted system tools that Windy Word can install on this machine to ' +
      'expand its capabilities (e.g. wtype for instant Wayland paste). Returns supported ' +
      'platform check + distro detection + the resolved install command per tool. Always ' +
      'safe to call (no system mutation). v0 supports Linux only — returns supported=false ' +
      'with a friendly explanation on macOS/Windows.',
  },
  wrap(async () => ok(await apiGet('/install/capabilities'))),
);

server.registerTool(
  'install_dependency',
  {
    description:
      'Install a missing system tool via the distro package manager wrapped in pkexec. ' +
      'WARNING: this triggers a graphical sudo (polkit) prompt that the user must approve ' +
      'interactively — do not call without telling the user a prompt will appear. The tool ' +
      'must be in Windy Word\'s whitelist: wtype, ydotool, wl-clipboard, xdotool. Linux only. ' +
      'After a successful install of wtype, re-check list_paste_strategies — wtype will flip ' +
      'to availableOnThisMachine=true and become first-pick in the resolved chain (paste ' +
      'becomes instant on Wayland-native targets). Use dryRun=true to see the command without ' +
      'executing it.',
    inputSchema: {
      tool: z
        .enum(['wtype', 'ydotool', 'wl-clipboard', 'xdotool', 'cliclick', 'ffmpeg'])
        .describe('Which tool to install. Constrained to the whitelist. Note: not every tool is installable on every OS (cliclick is macOS-only, the Wayland tools are Linux-only). Use list_installable_dependencies to see what works on the current machine.'),
      dryRun: z
        .boolean()
        .optional()
        .describe('If true, return the install command that WOULD run without executing it.'),
    },
  },
  wrap(async ({ tool, dryRun }) => {
    const body = { tool };
    if (dryRun !== undefined) body.dryRun = dryRun;
    // dnf/apt install can easily take >5s for metadata refresh + download. Use
    // a 10-minute ceiling that matches the windy-pro side's INSTALL_TIMEOUT_MS.
    return ok(await apiPost('/install', body, { timeoutMs: 10 * 60 * 1000 }));
  }),
);

server.registerTool(
  'get_install_history',
  {
    description:
      'Return the audit log of recent install_dependency attempts on this machine (timestamp, ' +
      'tool, package, exact command, exit code, elapsed ms, whether the tool is on PATH after, ' +
      'stdout/stderr tails). In-memory; resets when Windy Word restarts.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('Max entries (default 20).'),
    },
  },
  wrap(async ({ limit }) => {
    const qs = limit !== undefined ? `?limit=${limit}` : '';
    return ok(await apiGet(`/install/history${qs}`));
  }),
);

server.registerTool(
  'clear_install_history',
  {
    description: 'Wipe the in-memory install audit log. Useful between test runs.',
  },
  wrap(async () => ok(await apiPost('/install/history/clear'))),
);

server.registerTool(
  'install_dependency_async',
  {
    description:
      'Fire-and-poll variant of install_dependency. Returns a jobId immediately and runs the install in ' +
      'the background. Use get_install_status to check progress. Useful when the install might take >10 ' +
      'minutes (e.g., compiling from source, large package downloads on slow networks) or when the agent ' +
      'wants to surface a "still installing…" UI without holding a connection open. The whitelist + ' +
      'platform constraints + polkit/sudo flow are identical to install_dependency.',
    inputSchema: {
      tool: z
        .enum(['wtype', 'ydotool', 'wl-clipboard', 'xdotool', 'cliclick', 'ffmpeg'])
        .describe('Which tool to install.'),
      dryRun: z.boolean().optional().describe('If true, return the install command without actually running it.'),
    },
  },
  wrap(async ({ tool, dryRun }) => {
    const body = { tool };
    if (dryRun !== undefined) body.dryRun = dryRun;
    return ok(await apiPost('/install/start', body));
  }),
);

server.registerTool(
  'get_install_status',
  {
    description:
      'Return the current state of an async install job started by install_dependency_async. Status is ' +
      '"running" (still in flight) or "completed" (finished — check result.ok for success). If the job ' +
      'is not found (FIFO-evicted after 50 jobs, or wrong jobId), returns status="unknown".',
    inputSchema: {
      jobId: z.string().describe('Job id returned by install_dependency_async.'),
    },
  },
  wrap(async ({ jobId }) => ok(await apiGet(`/install/status?jobId=${encodeURIComponent(jobId)}`))),
);

server.registerTool(
  'list_install_jobs',
  {
    description:
      'List all install jobs currently in memory — both running and recently completed. Useful for dashboards or ' +
      'when an agent forgot a jobId.',
  },
  wrap(async () => ok(await apiGet('/install/jobs'))),
);

// ── Windy Doctor (local diagnostics) ────────────────────────────────────

server.registerTool(
  'run_diagnostics',
  {
    description:
      'Run the local Windy Doctor check battery and return a structured report: overall health ' +
      '(healthy / degraded / unhealthy), per-check status (ok / warning / error / not_applicable), ' +
      'severity, what was found, and (for non-ok findings) an actionable remediation step that often ' +
      'references the specific MCP tool to call next (e.g., "install_dependency({tool: \\"wtype\\"})"). ' +
      'Covers: paste-stack tooling presence, /dev/uinput permissions, ydotoold daemon health, polkit ' +
      'rule installation, Python transcription engine liveness, Mutter hotkey collision. No system ' +
      'mutation — pure read. Use this as the starting point for any "why is paste broken / why is ' +
      'transcription failing" agent flow.',
  },
  wrap(async () => ok(await apiGet('/doctor/diagnose'))),
);

server.registerTool(
  'list_diagnostic_checks',
  {
    description:
      'List the catalog of Windy Doctor diagnostic checks without running them. Returns each check\'s ' +
      'name, description, and whether it applies to this platform. Useful for agent introspection — ' +
      'understanding what the doctor knows how to look at before kicking off a diagnostic run.',
  },
  wrap(async () => ok(await apiGet('/doctor/checks'))),
);

server.registerTool(
  'cloud_diagnose',
  {
    description:
      'Run local diagnostics AND route the findings to the windy-fix-me cloud-relay for LLM-augmented ' +
      'remediation. Returns both the local rule-based findings and the cloud-relay\'s structured ' +
      'remediation (each entry has rootCause, a specific MCP tool call to invoke, fallback, verification ' +
      'steps). Use this when local run_diagnostics surfaces warnings/errors and you want expert-level ' +
      'fix guidance that knows about platform-specific quirks the local rules don\'t. Relay endpoint: ' +
      'https://windy-fix-me.windyword.workers.dev/diagnose (override via WINDY_FIX_ME_URL env var on the ' +
      'Windy Word side). May add ~2-3s of latency from the LLM round-trip.',
    inputSchema: {
      sharedSecret: z.string().optional().describe('Optional X-Windy-Fix-Me-Key for relays that require auth. Most public deployments leave this unset.'),
    },
  },
  // The relay can legitimately take >5s — bump timeout to match.
  wrap(async ({ sharedSecret }) => {
    const body = sharedSecret ? { sharedSecret } : {};
    return ok(await apiPost('/doctor/cloud-diagnose', body, { timeoutMs: 60 * 1000 }));
  }),
);

// ── settings catalog (the curated, validated surface) ───────────────────

server.registerTool(
  'list_settings',
  {
    description:
      'List every setting Windy Word exposes as an agent-discoverable, schema-validated path. Returns ' +
      'each setting\'s dotted path, type, description, allowed values (if enum / range), default, side ' +
      'effects of changing it, restartRequired flag, sensitivity (writable vs readonly), and the current ' +
      'live value. Use this as the entry point for any agent setting introspection — it covers the curated ' +
      'subset of get_config that has a known-safe schema. Paths outside this catalog are accessible only ' +
      'via the lower-level get_config / set_config tools.',
  },
  wrap(async () => ok(await apiGet('/settings/catalog'))),
);

server.registerTool(
  'describe_setting',
  {
    description:
      'Return the full catalog entry for one setting (type / allowed values / description / default / ' +
      'side effects / restartRequired / sensitivity) plus its current value from the live store. ' +
      'Returns an error if the path is not in the catalog — use get_config for paths outside it.',
    inputSchema: {
      path: z.string().describe('Dotted path (e.g. "engine.model", "paste.strategy", "hotkeys.toggleRecording").'),
    },
  },
  wrap(async ({ path }) => ok(await apiGet(`/settings/describe?path=${encodeURIComponent(path)}`))),
);

server.registerTool(
  'set_setting',
  {
    description:
      'Validate and apply a setting change against the catalog. Rejects unknown paths, type mismatches, ' +
      'out-of-range numbers, invalid enum values, malformed accelerators, and attempts to write read-only ' +
      'settings (e.g. license.*). On success, returns the previous + new value, any side effects that ' +
      'fired (e.g. "global shortcuts re-registered", "python engine hot-reload sent"), and whether a ' +
      'restart is required for the change to take full effect. Use set_config to bypass the catalog ' +
      '(low-level, no validation — for paths outside the catalog).',
    inputSchema: {
      path: z.string().describe('Dotted path. Get the catalog from list_settings.'),
      value: z.unknown().describe('New value. Must match the type the catalog declares for this path.'),
    },
  },
  wrap(async ({ path, value }) => ok(await apiPost('/settings/set', { path, value }))),
);

// ── config (low-level, no validation — escape hatch) ────────────────────

server.registerTool(
  'get_config',
  {
    description:
      'Return the full electron-store config tree (every setting Windy Word has persisted). ' +
      'Large but read-only — use this to discover what setting paths exist before set_config.',
  },
  wrap(async () => ok(await apiGet('/config'))),
);

server.registerTool(
  'set_config',
  {
    description:
      'Patch the config store. Pass EITHER {path, value} for a single dotted-path write ' +
      '(e.g. path="engine.model", value="small"), OR {patch: {...}} for a flat object of ' +
      'dotted-path → value pairs applied in order. Changes persist immediately.',
    inputSchema: {
      path: z.string().optional().describe('Dotted path (e.g. "engine.model").'),
      value: z.unknown().optional().describe('Value for the single-path form.'),
      patch: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Object of dotted-path → value, applied in iteration order.'),
    },
  },
  wrap(async ({ path, value, patch }) => {
    const body = {};
    if (path !== undefined) {
      body.path = path;
      body.value = value;
    }
    if (patch !== undefined) body.patch = patch;
    return ok(await apiPost('/config', body));
  }),
);

// ── actions (legacy GNOME-keybinding endpoints) ─────────────────────────

const ACTION_ENDPOINTS = {
  toggle_recording: '/toggle-recording',
  paste_transcript: '/paste-transcript',
  show_hide_window: '/show-hide',
  quick_translate: '/quick-translate',
};

const ACTION_DESCRIPTIONS = {
  toggle_recording:
    'Toggle voice recording on or off (same effect as the global hotkey). If currently idle, ' +
    'starts listening. If currently recording, stops and triggers the transcription + paste ' +
    'pipeline against whatever window had focus when recording started.',
  paste_transcript:
    'Re-paste the most recent transcript into the focused window (same effect as the ' +
    'paste-transcript hotkey). Does NOT start a new recording.',
  show_hide_window:
    'Cycle the Windy Word window through its three states: full → mini tornado → hidden → full.',
  quick_translate:
    'Open the Quick Translate mini-window.',
};

for (const [tool, path] of Object.entries(ACTION_ENDPOINTS)) {
  server.registerTool(
    tool,
    { description: ACTION_DESCRIPTIONS[tool] },
    // The legacy endpoints respond to GET with plain "OK" text.
    wrap(async () => ok(await apiGet(path))),
  );
}

// ── boot ─────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Helpful diagnostic to stderr (stdout is the MCP channel).
  const { baseUrl } = describeServer();
  console.error(`[windy-word-mcp ${SERVER_VERSION}] stdio transport ready, proxying to ${baseUrl}`);
}

main().catch((e) => {
  console.error('[windy-word-mcp] fatal:', e);
  process.exit(1);
});
