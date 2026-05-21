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

const SERVER_VERSION = '1.8.0';

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
  'run_paste_injection_test',
  {
    description:
      'Real end-to-end paste injection test. Spawns a focusable Tk scratchpad target, temporarily ' +
      'flips Mutter\'s focus-new-windows policy to "strict" so the target auto-grabs focus, fires the ' +
      'requested paste strategy, captures what landed in the target, and returns whether the captured ' +
      'text matches what was sent. SAFE TO RUN — the target is a spawned scratchpad, not the user\'s ' +
      'active window; the focus-policy flip is reverted after the test. Wayland+GNOME only in v0 (the ' +
      'gsettings focus-policy flip is GNOME-specific). Returns the paste-strategy attempt diagnostic too.',
    inputSchema: {
      strategy: z.string().optional().describe('Paste strategy to test (default "ydotool_type"). Use list_paste_strategies to discover names.'),
      text: z.string().optional().describe('Text to inject (default: a unique timestamped marker).'),
      captureSeconds: z.number().int().min(3).max(30).optional().describe('How long to keep the Tk target open after firing the paste (default 6s).'),
    },
  },
  wrap(async ({ strategy, text, captureSeconds }) => {
    const body = {};
    if (strategy) body.strategy = strategy;
    if (text !== undefined) body.text = text;
    if (captureSeconds !== undefined) body.captureSeconds = captureSeconds;
    return ok(await apiPost('/paste/inject-test', body, { timeoutMs: 60 * 1000 }));
  }),
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
  'setup_install_polkit_rule',
  {
    description:
      'Install or remove the Linux polkit auto-approve rule that lets install_dependency run without ' +
      'prompts. CRITICAL ONE-TIME SETUP for the agent-native install flow on a fresh machine: triggers ' +
      'a single pkexec password prompt for THIS call (the user types their password once); thereafter ' +
      'every install_dependency call for a whitelisted tool (wtype/ydotool/wl-clipboard/xdotool/ffmpeg) ' +
      'runs prompt-free. Uses subject.active so the rule applies to any logged-in user on the machine ' +
      '(not hardcoded to a single account). Linux only — returns 501 on macOS/Windows.\n\n' +
      'Recommended flow:\n' +
      '  1. run_diagnostics — see if install_polkit_rule check is warning\n' +
      '  2. setup_install_polkit_rule({enable: true}) — user types password once\n' +
      '  3. install_dependency({tool: "wtype"}) — silent install, no prompt\n\n' +
      'Pass enable=false to remove the rule (also triggers a polkit prompt).',
    inputSchema: {
      enable: z.boolean().describe('true to install the rule, false to remove it.'),
    },
  },
  // Generous timeout — pkexec prompt may sit waiting for the user.
  wrap(async ({ enable }) => ok(await apiPost('/install/polkit-rule', { enable }, { timeoutMs: 90 * 1000 }))),
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

// ── Soul file (v0.12.0) — Forma Animae export ───────────────────────────

server.registerTool(
  'export_soul_file_to_path',
  {
    description:
      'Export the user\'s entire Windy Word archive (audio + video + transcripts) as a single zip file ' +
      'at the given path. The Forma Animae artifact — Grant\'s exportable "soul" for use with the Windy ' +
      'Clone digital-twin pipeline or as a portable backup. Includes a manifest.json with stats (file ' +
      'counts, word counts, date range). Refuses to overwrite existing files unless overwrite=true. ' +
      'Creates parent directories as needed. Pairs with the existing export-soul-file IPC the renderer ' +
      'uses via the Soul File button (which opens a save dialog) — this is the path-based variant for ' +
      'agent-driven exports.',
    inputSchema: {
      outputPath: z.string().describe('Destination .zip path (e.g. "/home/user/Documents/my-soul-2026-05.zip").'),
      overwrite: z.boolean().optional().describe('If true, replace existing file. Default false.'),
    },
  },
  wrap(async ({ outputPath, overwrite }) => {
    const body = { outputPath };
    if (overwrite !== undefined) body.overwrite = overwrite;
    // Generous timeout — large archives can take a minute or two to zip.
    return ok(await apiPost('/soul-file/export', body, { timeoutMs: 5 * 60 * 1000 }));
  }),
);

// ── Transcribe arbitrary audio file (v0.11.0) ───────────────────────────

server.registerTool(
  'transcribe_audio_file',
  {
    description:
      'Transcribe an audio file at a given path. Accepts any format ffmpeg can read (wav, mp3, m4a, ' +
      'ogg, flac, webm, etc. — auto-detected). Routes through the same Python Whisper engine the ' +
      'Windy Word desktop app uses for live transcripts (no cold start when the engine is warm — ' +
      'WebSocket-routed for sub-second hand-off). Returns transcript text + timing diagnostics ' +
      '(transcribeMs, audioDurationSec, ratio = transcribe/audio, modelUsed). 500MB file cap; ' +
      '60s ffmpeg ceiling; 120s WS ceiling. Designed for individual files — agents wanting bulk ' +
      'processing should iterate over a directory and call this per file.',
    inputSchema: {
      path: z.string().describe('Absolute or working-dir-relative path to the audio file.'),
      language: z.string().optional().describe('ISO-639-1 language hint for Whisper (default "en"). Pass "auto" to let the model detect.'),
    },
  },
  wrap(async ({ path: audioPath, language }) => {
    const body = { path: audioPath };
    if (language !== undefined) body.language = language;
    // Generous timeout: 60s ffmpeg + 120s WS + slack — plus user audio could be long.
    return ok(await apiPost('/transcribe-file', body, { timeoutMs: 4 * 60 * 1000 }));
  }),
);

// ── Sound effects discovery (v1.2.0, read-only) ─────────────────────────

server.registerTool(
  'get_sound_effect_state',
  {
    description:
      'Return the current sound-effects configuration: per-hook-stage enabled/volume settings (the 6 ' +
      'stages are start, during, stop, process, warning, paste), the active sound pack, master SFX ' +
      'volume, and any per-stage custom sound overrides. The 6 hookStages are always returned even when ' +
      'live state read fails (so agents can show the stage catalog).\n\n' +
      '**Phase 1 limitation:** Sound state lives in renderer-side localStorage, not the main electron-' +
      'store. Reading via webContents.executeJavaScript currently fails (Electron context-isolation) — ' +
      'expect rendererReadable=false with rendererError set. Phase 2 will add a renderer-side IPC bridge ' +
      'in windy-pro to expose live state + writes.',
  },
  wrap(async () => ok(await apiGet('/sound-effects/state'))),
);

server.registerTool(
  'set_sound_hook',
  {
    description:
      'Configure a single sound-effect hook stage. Hooks are the 6 lifecycle points where Windy Word ' +
      'plays sounds: start (🎬 begin recording), during (🎤 mid-recording chirps), stop (⏹️ end ' +
      'recording), process (⏳ Whisper transcribing), warning (⚠️ approaching session limit), paste ' +
      '(📋 transcript injected). Each hook has enabled (boolean) + volume (0-100 int). Pass any combo ' +
      'of those args — omitted ones are unchanged. Routes through the renderer EffectsEngine and ' +
      'persists via _saveSettings to localStorage.',
    inputSchema: {
      hook: z.enum(['start', 'during', 'stop', 'process', 'warning', 'paste']).describe('Which of the 6 hook stages.'),
      enabled: z.boolean().optional().describe('Mute (false) / unmute (true) this stage.'),
      volume: z.number().int().min(0).max(100).optional().describe('Per-stage volume 0-100. Multiplies with master SFX volume.'),
    },
  },
  wrap(async ({ hook, enabled, volume }) => {
    const body = { hook };
    if (enabled !== undefined) body.enabled = enabled;
    if (volume !== undefined) body.volume = volume;
    return ok(await apiPost('/sound-effects/hook', body));
  }),
);

server.registerTool(
  'set_active_sound_pack',
  {
    description:
      'Switch the active sound pack. Pack ids come from list_sound_effect_packs — typical built-ins are ' +
      '"_silent", "classic-beep", "soft-chime". Affects all 6 hook stages unless individually overridden ' +
      'via custom-sound assignments. Persisted via EffectsEngine _saveSettings.',
    inputSchema: {
      packId: z.string().describe('Pack id (e.g. "classic-beep", "_silent").'),
    },
  },
  wrap(async ({ packId }) => ok(await apiPost('/sound-effects/active-pack', { packId }))),
);

server.registerTool(
  'set_master_sfx_volume',
  {
    description:
      'Set the master SFX volume (0-100). Affects every hook stage as a multiplier on per-stage volumes. ' +
      'Persists immediately to localStorage windy_sfxVolume and applies to the live EffectsEngine.sound ' +
      'master.',
    inputSchema: {
      volume: z.number().int().min(0).max(100).describe('Master SFX volume 0-100. 0 = silent, 100 = full.'),
    },
  },
  wrap(async ({ volume }) => ok(await apiPost('/sound-effects/master-volume', { volume }))),
);

server.registerTool(
  'set_sound_effect_mode',
  {
    description:
      'Switch the EffectsEngine mode: "silent" (no sounds), "classic" (built-in beeps), "surprise" ' +
      '(random selection from a category), "custom" (per-hook user-assigned sounds), "pack" (active ' +
      'pack drives everything). Persisted via _saveSettings.',
    inputSchema: {
      mode: z.enum(['silent', 'classic', 'surprise', 'custom', 'pack']),
    },
  },
  wrap(async ({ mode }) => ok(await apiPost('/sound-effects/mode', { mode }))),
);

server.registerTool(
  'get_widget_state',
  {
    description:
      'Return mini-widget (tornado) runtime state via the renderer bridge: whether the WidgetEngine is ' +
      'present, whether the widget is currently visible, and the localStorage tornadoSize value. ' +
      'Complements the catalog-driven set_setting path for tornadoX/tornadoY/tornadoSize/widgetSettings.',
  },
  wrap(async () => ok(await apiGet('/widget/state'))),
);

server.registerTool(
  'list_sound_effect_packs',
  {
    description:
      'List the sound-effect packs the Windy Word EffectsEngine knows about (_silent, classic-beep, ' +
      'soft-chime, and other built-in synthesized packs). Pairs with the 6 hook stages (start/during/' +
      'stop/process/warning/paste) to drive per-stage sound assignments.\n\n' +
      '**Phase 1 limitation:** Same as get_sound_effect_state — the renderer EffectsEngine isn\'t ' +
      'globally exposed, so live pack-list queries return ok=false until Phase 2 (renderer-side IPC ' +
      'bridge). The endpoint shape is finalized for forward-compat.',
  },
  wrap(async () => ok(await apiGet('/sound-effects/packs'))),
);

// ── Misc utilities (v0.10.0) ────────────────────────────────────────────

server.registerTool(
  'detect_hardware',
  {
    description:
      'Return system hardware info: totalRAM (GB), freeRAM (GB), cpuModel, cpuCores, platform, arch, ' +
      'gpu (NVIDIA via nvidia-smi on Linux/Windows; Apple Silicon Metal/MPS on macOS arm64; null otherwise), ' +
      'diskFreeGB (homedir partition). Used by Doctor checks and model-selection decisions — bigger models ' +
      'need more RAM, GPU-accelerated paths only fire when gpu != null.',
  },
  wrap(async () => ok(await apiGet('/hardware'))),
);

server.registerTool(
  'get_autostart_status',
  {
    description:
      'Check whether Windy Word is configured to auto-launch on user login. Returns {platform, enabled, ' +
      'desktopFile?}. Linux checks for ~/.config/autostart/windy-pro.desktop; macOS/Windows use ' +
      'electron\'s app.getLoginItemSettings(). Pure read — no state change.',
  },
  wrap(async () => ok(await apiGet('/autostart'))),
);

server.registerTool(
  'set_autostart',
  {
    description:
      'Enable or disable Windy Word\'s auto-launch on user login. Linux writes/removes a .desktop ' +
      'autostart entry; macOS/Windows toggle via Electron\'s setLoginItemSettings. Returns the resulting ' +
      'state (enabled boolean) so agents can verify the change took.',
    inputSchema: {
      enable: z.boolean().describe('true to enable autostart, false to disable.'),
    },
  },
  wrap(async ({ enable }) => ok(await apiPost('/autostart', { enable }))),
);

// ── Translation (v0.9.0) ────────────────────────────────────────────────

server.registerTool(
  'translate_text',
  {
    description:
      'Translate text to a target language. Tries the local translation-memory cache first (instant + ' +
      'free); on miss, calls Groq (preferred) or OpenAI via Windy Word\'s configured key. The TM cache ' +
      'auto-populates from successful calls so repeat translations are free. Source language defaults to ' +
      '"auto" (model detects); only concrete source-lang calls hit the TM. Returns {ok, translation, ' +
      'fromCache, sourceLang, targetLang, engine}.',
    inputSchema: {
      text: z.string().describe('Text to translate.'),
      targetLang: z.string().describe('Target language code (e.g. "es", "fr", "ja").'),
      sourceLang: z.string().optional().describe('Source language code or "auto" (default).'),
    },
  },
  wrap(async ({ text, targetLang, sourceLang }) => {
    const body = { text, targetLang };
    if (sourceLang) body.sourceLang = sourceLang;
    return ok(await apiPost('/translate', body, { timeoutMs: 30 * 1000 }));
  }),
);

server.registerTool(
  'lookup_translation_memory',
  {
    description:
      'Look up a (text, sourceLang, targetLang) tuple in the local translation-memory cache. Returns ' +
      '{ok, match: {translation, hits} | null}. No external API call — pure local SQLite query.',
    inputSchema: {
      text: z.string().describe('Source text to look up.'),
      sourceLang: z.string().describe('Source language code.'),
      targetLang: z.string().describe('Target language code.'),
    },
  },
  wrap(async ({ text, sourceLang, targetLang }) => ok(await apiPost('/translation-memory/lookup', { text, sourceLang, targetLang }))),
);

server.registerTool(
  'save_translation_memory',
  {
    description:
      'Store a (source, target, sourceLang, targetLang) tuple in the TM cache. Useful when an agent has ' +
      'a known-good translation it wants future lookups to find without re-calling the LLM. Upserts on ' +
      'duplicate keys (increments the hits counter).',
    inputSchema: {
      source: z.string().describe('Source text.'),
      target: z.string().describe('Target translation.'),
      sourceLang: z.string().describe('Source language code.'),
      targetLang: z.string().describe('Target language code.'),
    },
  },
  wrap(async ({ source, target, sourceLang, targetLang }) => ok(await apiPost('/translation-memory/save', { source, target, sourceLang, targetLang }))),
);

server.registerTool(
  'get_translation_memory_stats',
  {
    description:
      'Return TM cache stats: totalEntries, topPairs (top 10 source→target language pairs by count), ' +
      'recentEntries (last 50 by updated_at).',
  },
  wrap(async () => ok(await apiGet('/translation-memory/stats'))),
);

server.registerTool(
  'clear_translation_memory',
  {
    description:
      'Wipe the entire translation-memory cache. Destructive — confirm with the user before calling.',
  },
  wrap(async () => ok(await apiPost('/translation-memory/clear'))),
);

// ── Documents (v0.9.0) ──────────────────────────────────────────────────

server.registerTool(
  'extract_document_text',
  {
    description:
      'Extract plain text from a document file at a given path. Supports .txt / .md / .csv (read as ' +
      'UTF-8), .html (strip tags), .pdf (regex scrape — best-effort, may return [PDF text extraction ' +
      'yielded nothing] for image-only PDFs), .docx (xml-strip). Default size cap 5MB; override via ' +
      'maxBytes (up to 20MB). Returns {ok, path, ext, sizeBytes, textLength, text}.',
    inputSchema: {
      path: z.string().describe('Absolute or working-dir-relative file path.'),
      maxBytes: z.number().int().min(1024).max(20 * 1024 * 1024).optional().describe('Max file size to attempt (default 5MB).'),
    },
  },
  wrap(async ({ path: filePath, maxBytes }) => {
    const body = { path: filePath };
    if (maxBytes !== undefined) body.maxBytes = maxBytes;
    return ok(await apiPost('/docs/extract', body, { timeoutMs: 30 * 1000 }));
  }),
);

server.registerTool(
  'save_text_file',
  {
    description:
      'Write text content to a file at a given path. Default: refuses to overwrite existing files (returns ' +
      'a 409-shaped error with the existing file size). Pass overwrite=true to replace. Creates parent ' +
      'directories as needed. Returns {ok, path, bytesWritten}.',
    inputSchema: {
      path: z.string().describe('Absolute or working-dir-relative target path.'),
      content: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('String content, or an object (will be JSON-stringified).'),
      overwrite: z.boolean().optional().describe('If true, replace existing file. Default false.'),
    },
  },
  wrap(async ({ path: filePath, content, overwrite }) => {
    const body = { path: filePath, content };
    if (overwrite !== undefined) body.overwrite = overwrite;
    return ok(await apiPost('/docs/save', body));
  }),
);

// ── Archive (v0.8.0) ────────────────────────────────────────────────────

server.registerTool(
  'list_archive_entries',
  {
    description:
      'List archived recording sessions (the user\'s historical transcripts + linked audio/video). Each ' +
      'entry has an opaque id (use it with read_archive or delete_archive_entry), date, full transcript ' +
      'text, wordCount, engine used, and hasAudio / hasVideo booleans. Newest first. Path information is ' +
      'NOT returned — agents work with the opaque id.',
    inputSchema: {
      limit: z.number().int().min(1).max(1000).optional().describe('Cap on entries returned (default 200).'),
    },
  },
  wrap(async ({ limit }) => {
    const qs = limit !== undefined ? `?limit=${limit}` : '';
    return ok(await apiGet(`/archive${qs}`));
  }),
);

server.registerTool(
  'get_archive_stats',
  {
    description:
      'Return aggregate stats for the user\'s recording archive: totalFiles, totalSizeMB, days (number of ' +
      'distinct date directories), audioHours, videoHours, totalWords, totalSessions, totalChars. Cached ' +
      'server-side for 30s — responses include `cached` + `cacheAgeSec` so the agent knows freshness.',
  },
  wrap(async () => ok(await apiGet('/archive/stats'))),
);

server.registerTool(
  'read_archive_entry',
  {
    description:
      'Return an archive entry\'s metadata + optionally the base64 audio or video media bytes. The ' +
      'mediaType parameter selects which stream ("audio" default, or "video"). Pass metadataOnly=true to ' +
      'skip the base64 payload (responses can be MBs otherwise). Returns { ok, present, mimeType, base64 } ' +
      'or { ok, present: false } if the requested media isn\'t attached to this entry.',
    inputSchema: {
      id: z.string().describe('Archive entry id (from list_archive_entries).'),
      mediaType: z.enum(['audio', 'video']).optional().describe('Which media stream (default "audio").'),
      metadataOnly: z.boolean().optional().describe('If true, skip the base64 media payload.'),
    },
  },
  wrap(async ({ id, mediaType, metadataOnly }) => {
    const body = { id };
    if (mediaType !== undefined) body.mediaType = mediaType;
    if (metadataOnly !== undefined) body.metadataOnly = metadataOnly;
    return ok(await apiPost('/archive/read', body, { timeoutMs: 60 * 1000 }));
  }),
);

server.registerTool(
  'delete_archive_entry',
  {
    description:
      'Tear down an archive entry: removes the transcript .md file + linked audio + linked video, all ' +
      'path-confined to the archive folder. Irreversible — confirm with the user before calling. Returns ' +
      'the list of filenames actually deleted.',
    inputSchema: {
      id: z.string().describe('Archive entry id (from list_archive_entries).'),
    },
  },
  wrap(async ({ id }) => ok(await apiPost('/archive/delete', { id }))),
);

server.registerTool(
  'open_archive_folder',
  {
    description:
      'Pop the archive root directory in the user\'s OS file manager. Side-effect on the desktop ' +
      '(opens a Files / Finder / Explorer window). Use when the user asks "show me where my recordings ' +
      'are saved" or similar.',
  },
  wrap(async () => ok(await apiPost('/archive/open-folder'))),
);

// ── Voice clones (v0.7.0) ───────────────────────────────────────────────

server.registerTool(
  'list_voice_clones',
  {
    description:
      'List all voice clones the user has on this machine. Returns each clone\'s id, name, duration, ' +
      'created_at, status, plus a hasAudio boolean (no raw audio in the response — use preview_voice_clone ' +
      'to fetch base64 audio for a specific clone). Also returns activeId — which clone is the current ' +
      'TTS default. Use this to answer "what clones does the user have?" without paging through audio bytes.',
  },
  wrap(async () => ok(await apiGet('/voice-clones'))),
);

server.registerTool(
  'get_active_voice_clone',
  {
    description:
      'Return the currently-active voice clone (the one used for TTS playback), or {active: null} if no ' +
      'clone is selected.',
  },
  wrap(async () => ok(await apiGet('/voice-clones/active'))),
);

server.registerTool(
  'set_active_voice_clone',
  {
    description:
      'Set which voice clone is the active TTS default. Pass id=null to deactivate (no clone — falls back ' +
      'to built-in TTS). The id must match an existing clone (use list_voice_clones to discover ids).',
    inputSchema: {
      id: z.string().nullable().describe('Clone id, or null to deactivate.'),
    },
  },
  wrap(async ({ id }) => ok(await apiPost('/voice-clones/active', { id }))),
);

server.registerTool(
  'delete_voice_clone',
  {
    description:
      'Delete a voice clone (metadata + audio file on disk). If the deleted clone was the active one, ' +
      'activeId is reset to null. Returns the deleted clone\'s id and name for audit purposes. ' +
      'Irreversible — confirm with the user before calling.',
    inputSchema: {
      id: z.string().describe('Clone id to delete.'),
    },
  },
  wrap(async ({ id }) => ok(await apiPost('/voice-clones/delete', { id }))),
);

server.registerTool(
  'preview_voice_clone',
  {
    description:
      'Return a voice clone\'s metadata, optionally with the base64-encoded audio sample. Pass ' +
      'metadataOnly=true to skip the audio (responses can be several MB otherwise). The mimeType field ' +
      'tells the agent how to interpret audioBase64 (typically audio/webm).',
    inputSchema: {
      id: z.string().describe('Clone id.'),
      metadataOnly: z.boolean().optional().describe('If true, skip the base64 audio payload. Defaults to false (audio included).'),
    },
  },
  wrap(async ({ id, metadataOnly }) => {
    const body = { id };
    if (metadataOnly !== undefined) body.metadataOnly = metadataOnly;
    return ok(await apiPost('/voice-clones/preview', body, { timeoutMs: 30 * 1000 }));
  }),
);

server.registerTool(
  'create_voice_clone_from_path',
  {
    description:
      'Create a voice clone from an audio file on disk. Copies the source file into Windy Word\'s ' +
      'voice-samples directory under a fresh UUID, registers the clone in the local DB, and returns ' +
      'the new clone\'s metadata (with hasAudio=true). Supported audio extensions: .webm, .wav, .mp3, ' +
      '.ogg, .m4a, .flac. Source file must exist and be readable; the copy itself is path-confined to ' +
      'Windy\'s voice-samples dir. Use list_voice_clones afterward to see it and set_active_voice_clone ' +
      'to activate.',
    inputSchema: {
      name: z.string().describe('Human-readable name for the clone (e.g. "My Voice 2026-05").'),
      sourcePath: z.string().describe('Path to the source audio file.'),
      durationSec: z.number().optional().describe('Audio duration in seconds (if known). Optional metadata.'),
    },
  },
  wrap(async ({ name, sourcePath, durationSec }) => {
    const body = { name, sourcePath };
    if (durationSec !== undefined) body.durationSec = durationSec;
    return ok(await apiPost('/voice-clones/create', body, { timeoutMs: 30 * 1000 }));
  }),
);

server.registerTool(
  'submit_voice_clone_to_cloud',
  {
    description:
      'Submit a local voice clone to Windy Clone for ElevenLabs training. Idempotent on cloud_order_id: ' +
      'if the clone has already been submitted, returns { ok: false, error: "Already submitted...", ' +
      'cloud_order_id: <existing> } without firing a second submission. Requires the user to be signed ' +
      'in to their Windy account (auth.token in electron-store). On success returns { ok: true, ' +
      'order_id, status }; poll get_cloud_clone_order_status with the returned order_id for training ' +
      'progress. Get clone ids from list_voice_clones.',
    inputSchema: {
      cloneId: z.string().describe('Local clone id from list_voice_clones (e.g. "vc_2026-05-21_abc123").'),
    },
  },
  wrap(async ({ cloneId }) => ok(await apiPost('/clones/cloud/submit', { cloneId }, { timeoutMs: 35 * 1000 }))),
);

server.registerTool(
  'get_cloud_clone_order_status',
  {
    description:
      'Check the status of a Windy Clone cloud-training order — used after submit_voice_clone_to_cloud ' +
      'to poll for ElevenLabs training completion. Requires the user to be signed in to their Windy ' +
      'account; returns a clean 401-shape error if not. Returns the raw order body from the Windy ' +
      'Clone API.',
    inputSchema: {
      orderId: z.string().describe('Order id returned from a previous submit_voice_clone_to_cloud call.'),
    },
  },
  wrap(async ({ orderId }) => ok(await apiPost('/voice-clones/cloud-order-status', { orderId }))),
);

server.registerTool(
  'list_clone_bundles',
  {
    description:
      'List training-bundle catalog — audio/video recordings the user has marked as candidates for ' +
      'voice-clone training. Each entry has bundle_id, name, device info, sync_status, training_ready ' +
      'flag, file size, created_at, and fileExists. Pairs with InstaBio voice-clone ingestion which ' +
      'reads from these bundles. See [[project_instabio_voice_clone_data]] memory for the broader ' +
      'voice-clone training-data contract.',
  },
  wrap(async () => ok(await apiGet('/clone-bundles'))),
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
      'effects of changing it, restartRequired flag, sensitivity (writable vs readonly), tags, and the ' +
      'current live value. The response also includes availableTags so agents can discover what tag ' +
      'filters exist. Use this as the entry point for any agent setting introspection. Paths outside ' +
      'the catalog are accessible only via the lower-level get_config / set_config tools. Optional `tag` ' +
      'parameter narrows results — e.g. tag="voice-clone" returns just the settings that drive InstaBio ' +
      'voice-clone training behavior, tag="archive" returns archive-related settings, etc.',
    inputSchema: {
      tag: z.string().optional().describe('Optional tag to filter by (voice-clone, archive, transcription, paste, hotkey, ui, geometry, lifecycle, etc). See availableTags in the unfiltered response.'),
    },
  },
  wrap(async ({ tag }) => {
    const qs = tag ? `?tag=${encodeURIComponent(tag)}` : '';
    return ok(await apiGet(`/settings/catalog${qs}`));
  }),
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

// ── UI-parity sweep (2026-05-20 OC5 audit coverage) ────────────────────
// Thin wrappers over new control-server endpoints + new settings-catalog
// paths added in sneakyfree/windy-pro PRs #148-#151. Closes the agent-
// surface gaps surfaced during the full UI feature audit on OC5: every
// Settings → About / Appearance / Bottom Panel / Analytics / Transcription
// → Language UI control now has a dedicated MCP wrapper. set_setting
// + get_config still work as the generic escape hatch for paths not yet
// wrapped here.

server.registerTool(
  'get_version',
  {
    description:
      'Return the running Windy Word version (app.getVersion()) plus the underlying ' +
      'Electron and Node versions. Mirrors the "Windy Word v1.6.2" display in Settings → ' +
      'About. Read-only and safe to call.',
  },
  wrap(async () => {
    const platform = await apiGet('/platform');
    return ok({
      version: platform.version,
      electronVersion: platform.electronVersion,
      nodeVersion: platform.nodeVersion,
    });
  }),
);

// ── Archive deep-control (Wave W2 — UI-parity sweep) ─────────────────────
// Turns the archive from a list-and-fetch surface into a queryable database.
// Pairs with /archive/search, /archive/by-date, /archive/bulk-delete added
// in windy-pro's Wave W2 PR.

server.registerTool(
  'search_archives',
  {
    description:
      'Full-text substring search across every archived transcript. Returns matches with a ' +
      'short snippet of surrounding context. Case-insensitive by default. Scales to thousands ' +
      'of entries (the scan is a single _agentArchiveScan pass + in-memory filter). Use this ' +
      'when the user asks "what did I say about X" or "when did I last talk to Y". For richer ' +
      'queries (regex, semantic, embedding) — defer; this is the fast substring path.',
    inputSchema: {
      query: z.string().min(1).describe('Substring to search for. Required.'),
      limit: z.number().int().min(1).max(1000).optional().describe('Cap the returned match count. Default 200.'),
      caseInsensitive: z.boolean().optional().describe('Default true. Pass false for exact-case matching.'),
      includeBody: z.boolean().optional().describe('Default false. Pass true to include the full transcript text on each match (otherwise only a snippet).'),
    },
  },
  wrap(async ({ query, limit, caseInsensitive, includeBody }) => {
    const body = { query };
    if (limit !== undefined) body.limit = limit;
    if (caseInsensitive !== undefined) body.caseInsensitive = caseInsensitive;
    if (includeBody !== undefined) body.includeBody = includeBody;
    return ok(await apiPost('/archive/search', body));
  }),
);

server.registerTool(
  'check_for_updates',
  {
    description:
      'Trigger electron-updater\'s update check. Mirrors the "Check for Updates" button in ' +
      'Settings → About. Returns immediately; the actual check runs asynchronously. Agents ' +
      'can poll get_config lastUpdateCheck to see when it last ran. SAFE — only downloads; ' +
      'install still requires a user-driven quitAndInstall via the in-app button.',
  },
  wrap(async () => ok(await apiPost('/updates/check', {}))),
);

server.registerTool(
  'set_theme',
  {
    description:
      'Switch the UI theme. "dark" / "light" force one mode; "auto" follows the OS appearance. ' +
      'Mirrors Settings → Appearance → Theme. Persists to electron-store and propagates to ' +
      'the renderer (light-theme body class + localStorage.windy_theme) live — no app restart.',
    inputSchema: {
      theme: z.enum(['dark', 'light', 'auto']).describe('Theme mode.'),
    },
  },
  wrap(async ({ theme }) =>
    ok(await apiPost('/settings/set', { path: 'appearance.theme', value: theme })),
  ),
);

// ── Window + state observability (Wave W1 — UI-parity sweep) ──────────
// Wraps the new /window/* and /recording/state endpoints. Lets agents do
// what the title bar buttons do (minimize / maximize / move / resize),
// adjust font size, take a state snapshot, and poll the recording-flow
// state without blind-polling for events. Note: on macOS the main window
// is focusable:false (recording focus-theft defense), so bring-to-front
// will NOT steal keyboard focus from the user's external app. That's the
// invariant, not a bug.

server.registerTool(
  'get_window_state',
  {
    description:
      'Snapshot the main window\'s current state: exists, maximized, minimized, focused, visible, ' +
      'fullScreen, simpleFullScreen, bounds {x,y,width,height}, fontSize, opacity, alwaysOnTop. ' +
      'Read-only. The cheapest call to find out "is the user actively using the app right now" — ' +
      'check focused + isRecording (via get_recording_state) before doing anything intrusive.',
  },
  wrap(async () => ok(await apiGet('/window'))),
);

server.registerTool(
  'minimize_window',
  {
    description:
      'Minimize the main Windy Word window to the dock/taskbar. Mirrors the title-bar minimize ' +
      'button. Idempotent — calling on an already-minimized window is a no-op.',
  },
  wrap(async () => ok(await apiPost('/window/minimize', {}))),
);

server.registerTool(
  'maximize_window',
  {
    description:
      'Maximize the main Windy Word window to fill the screen. Mirrors the title-bar maximize ' +
      'button. Different from fullscreen: keeps the title bar visible and stays in the current ' +
      'OS space. Use set_video_fullscreen for true fullscreen.',
  },
  wrap(async () => ok(await apiPost('/window/maximize', {}))),
);

server.registerTool(
  'unmaximize_window',
  {
    description:
      'Restore the main window from maximized to its previous size. No-op if not maximized.',
  },
  wrap(async () => ok(await apiPost('/window/unmaximize', {}))),
);

server.registerTool(
  'bring_window_to_front',
  {
    description:
      'Restore the window if minimized, show it if hidden, and raise it above other windows. ' +
      'DOES NOT steal keyboard focus on macOS — the main window is focusable:false to protect ' +
      'the recording flow from focus-theft against the user\'s external app. The window comes ' +
      'to the visual front; input focus stays where it was. Returns {focused:false} on macOS to ' +
      'make this explicit.',
  },
  wrap(async () => ok(await apiPost('/window/bring-to-front', {}))),
);

server.registerTool(
  'set_window_geometry',
  {
    description:
      'Set the main window\'s position and size in screen pixels. Updates the live window AND ' +
      'persists to window.{x,y,width,height} so it survives restart. Useful for arranging the ' +
      'app before a demo or moving it to a specific monitor.',
    inputSchema: {
      x: z.number().describe('Window x position in screen pixels.'),
      y: z.number().describe('Window y position in screen pixels.'),
      width: z.number().int().min(200).max(4000).describe('Window width in pixels (200-4000).'),
      height: z.number().int().min(200).max(4000).describe('Window height in pixels (200-4000).'),
    },
  },
  wrap(async ({ x, y, width, height }) =>
    ok(await apiPost('/window/geometry', { x, y, width, height })),
  ),
);

server.registerTool(
  'set_analytics_enabled',
  {
    description:
      'Opt in or out of anonymous usage analytics (engine, duration, mode, language — never ' +
      'transcript content). Mirrors Settings → Analytics → "Help improve Windy Word". Off by ' +
      'default. Live-applies to the renderer\'s localStorage flag.',
    inputSchema: {
      enabled: z.boolean().describe('true = opt in, false = opt out.'),
    },
  },
  wrap(async ({ enabled }) =>
    ok(await apiPost('/settings/set', { path: 'analytics.enabled', value: enabled })),
  ),
);

server.registerTool(
  'set_panel_visibility',
  {
    description:
      'Configure how one of the bottom panel rows behaves in the main app: "always" pins ' +
      'it open, "hover" reveals it when the cursor is near the bottom edge, "hidden" never ' +
      'shows it. Mirrors Settings → Bottom Panel. "playback" and "export" default to "hover"; ' +
      '"control" defaults to "always".',
    inputSchema: {
      panel: z.enum(['playback', 'export', 'control']).describe('Which row to configure.'),
      mode: z.enum(['always', 'hover', 'hidden']).describe('Visibility behavior.'),
    },
  },
  wrap(async ({ panel, mode }) =>
    ok(await apiPost('/settings/set', { path: `bottomPanel.${panel}`, value: mode })),
  ),
);

server.registerTool(
  'set_language',
  {
    description:
      'Set the Whisper transcription language. ISO 639-1 code (e.g. "en", "es", "fr", "ja", ' +
      '"zh", "ar", "hi", "de", "pt", "ko", "ru", "it", "nl", "pl", "tr", "sv", "vi", "th") ' +
      '— or "auto" to let Whisper detect per-utterance. Mirrors Settings → Transcription → ' +
      'Language. Hot-swappable: the live Python engine reconfigures over WebSocket without ' +
      'app restart; the new language applies on the next recording.',
    inputSchema: {
      language: z.string().describe('ISO 639-1 code or "auto".'),
    },
  },
  wrap(async ({ language }) =>
    ok(await apiPost('/settings/set', { path: 'engine.language', value: language })),
  ),
);

server.registerTool(
  'open_url',
  {
    description:
      'Open an http/https URL or one of the Windy ecosystem schemes (windypro://, windychat://, ' +
      'windyword://, windyfly://) in the user\'s default browser via Electron\'s shell.openExternal. ' +
      'Mirrors UI buttons like "View all history in Web Portal" and the Upgrade → checkout ' +
      'flow. Allowlisted: file://, javascript:, and other dangerous schemes are rejected with 403.',
    inputSchema: {
      url: z.string().describe('URL to open. Must use an allowlisted protocol.'),
    },
  },
  wrap(async ({ url }) => ok(await apiPost('/open-url', { url }))),
);

server.registerTool(
  'reset_hotkeys',
  {
    description:
      'Restore all global keyboard shortcuts to their catalog defaults and re-register them. ' +
      'Mirrors the "Reset All to Defaults" button in Settings → Keyboard Shortcuts. Returns ' +
      'the applied bindings so the agent can confirm. Idempotent — safe to call repeatedly.',
  },
  wrap(async () => ok(await apiPost('/hotkeys/reset', {}))),
);

server.registerTool(
  'set_font_size',
  {
    description:
      'Set the UI font-size zoom factor (70-150%). 100 is default. Mirrors the A- / A+ buttons ' +
      'in the Settings header. Persists to appearance.fontSize and broadcasts a font-size-changed ' +
      'event to the renderer so the live UI updates immediately.',
    inputSchema: {
      percent: z.number().int().min(70).max(150).describe('Zoom percentage. Clamped to 70-150.'),
    },
  },
  wrap(async ({ percent }) => ok(await apiPost('/window/font-size', { percent }))),
);

server.registerTool(
  'set_video_fullscreen',
  {
    description:
      'Toggle the main window into native OS-level fullscreen. On macOS uses setSimpleFullScreen ' +
      '(works with the focusable:false main window — doesn\'t need key window); other platforms ' +
      'use standard setFullScreen. Used by the History video-expand button (PR #143). For UI font ' +
      'zoom use set_font_size; for in-window maximize use maximize_window.',
    inputSchema: {
      on: z.boolean().describe('true = enter fullscreen, false = exit.'),
    },
  },
  wrap(async ({ on }) => ok(await apiPost('/window/video-fullscreen', { on }))),
);

server.registerTool(
  'get_recording_state',
  {
    description:
      'Return the recording-flow state: isRecording (main-process truth), pythonEngineRunning ' +
      '(transcription backend alive), totalPasteAttempts (counter — increments after every paste ' +
      'attempt; use to detect activity between polls). Read-only and cheap. Use this BEFORE doing ' +
      'anything intrusive — if isRecording=true, the user is actively recording and you should ' +
      'defer or use toggle_recording to stop them gracefully.',
  },
  wrap(async () => ok(await apiGet('/recording/state'))),
);

server.registerTool(
  'archives_by_date_range',
  {
    description:
      'Return archived sessions whose start timestamp falls within [from, to]. Either endpoint ' +
      'is optional — omit from for "since beginning", omit to for "until now". Sorted newest ' +
      'first. Use ISO 8601 (date or date+time, e.g. "2026-05-20" or "2026-05-20T18:00:00Z").',
    inputSchema: {
      from: z.string().optional().describe('ISO 8601 start of window. Inclusive.'),
      to: z.string().optional().describe('ISO 8601 end of window. Inclusive.'),
      limit: z.number().int().min(1).max(1000).optional().describe('Cap the returned entry count. Default 200.'),
    },
  },
  wrap(async ({ from, to, limit }) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (limit !== undefined) params.set('limit', String(limit));
    const qs = params.toString();
    return ok(await apiGet('/archive/by-date' + (qs ? '?' + qs : '')));
  }),
);

server.registerTool(
  'bulk_delete_archives',
  {
    description:
      'Tear down multiple archive entries in one call. Each entry\'s .md transcript + linked ' +
      'audio + linked video are removed. REQUIRES an explicit confirm token "YES-DELETE-<N>" ' +
      'where N matches the ids.length — this is the guard that prevents an agent hallucinating ' +
      '"yes" and accidentally wiping the entire history. Each id\'s outcome is reported ' +
      'independently in the response (not-found ids do not abort the batch).',
    inputSchema: {
      ids: z.array(z.string()).min(1).describe('Archive ids to delete (from list_archive_entries / search_archives / archives_by_date_range).'),
      confirm: z.string().describe('Must equal "YES-DELETE-<N>" where N is ids.length. Mismatch returns 400.'),
    },
  },
  wrap(async ({ ids, confirm }) => ok(await apiPost('/archive/bulk-delete', { ids, confirm }))),
);

// ── Lifecycle + finishing surfaces (Wave W4 + W2 cont'd) ────────────────
// App lifecycle, window control, notifications, bulk archive text export.

server.registerTool(
  'cancel_recording',
  {
    description:
      'Cancel an in-flight recording without saving the result. Safe to call when idle (returns ' +
      'wasRecording:false). Unlike toggle_recording which stops the recording AND triggers ' +
      'transcribe + paste, this drops the audio entirely. Useful when the agent realizes the ' +
      'recording was started by mistake or the user said "wait, scratch that".',
  },
  wrap(async () => ok(await apiPost('/recording/cancel', {}))),
);

server.registerTool(
  'restart_app',
  {
    description:
      'Relaunch Windy Word. app.relaunch() + app.exit(0). Returns 200 immediately; the actual ' +
      'exit fires ~250ms later so this response lands. DESTRUCTIVE — closes the running app, ' +
      'losing any in-flight recording. Get user confirmation before calling.',
  },
  wrap(async () => ok(await apiPost('/app/restart', {}))),
);

server.registerTool(
  'quit_app',
  {
    description:
      'Quit Windy Word cleanly. app.quit(). Returns 200 immediately; exit fires ~250ms later. ' +
      'DESTRUCTIVE — app will not auto-restart. Get user confirmation before calling.',
  },
  wrap(async () => ok(await apiPost('/app/quit', {}))),
);

server.registerTool(
  'set_always_on_top',
  {
    description:
      'Toggle whether the Windy Word window stays above other windows. Mirrors Settings → ' +
      'Appearance → Always on Top. Live update on the window + persist to ' +
      'appearance.alwaysOnTop. Idempotent.',
    inputSchema: {
      on: z.boolean().describe('true = pin above all, false = normal Z-order.'),
    },
  },
  wrap(async ({ on }) => ok(await apiPost('/window/always-on-top', { on }))),
);

server.registerTool(
  'set_opacity',
  {
    description:
      'Set the Windy Word window opacity (0.1 = mostly transparent, 1.0 = fully opaque). Mirrors ' +
      'Settings → Appearance → Window Opacity. Live update on the window + persist to ' +
      'appearance.opacity. Values outside [0.1, 1.0] are rejected.',
    inputSchema: {
      value: z.number().min(0.1).max(1.0).describe('Opacity 0.1-1.0.'),
    },
  },
  wrap(async ({ value }) => ok(await apiPost('/window/opacity', { value }))),
);

server.registerTool(
  'send_notification',
  {
    description:
      'Show an OS-native notification via Electron\'s Notification API. Returns ok:true if ' +
      'shown. Title is capped at 200 chars, body at 1000 chars. Pass silent:true to suppress ' +
      'sound. Returns 500 on platforms where notifications aren\'t supported.',
    inputSchema: {
      title: z.string().min(1).max(200).describe('Notification title (1-200 chars).'),
      body: z.string().max(1000).optional().describe('Notification body (up to 1000 chars).'),
      silent: z.boolean().optional().describe('Suppress notification sound (default false).'),
    },
  },
  wrap(async ({ title, body, silent }) => ok(await apiPost('/notifications/send', { title, body, silent }))),
);

server.registerTool(
  'bulk_export_archives_text',
  {
    description:
      'Export the transcript text of multiple archive entries to a directory. One file per ' +
      'entry, named by the archive id. Format = "md" (default — with header), "txt" (plain ' +
      'transcript), or "json" (full entry metadata + text). targetDir is created recursively ' +
      'if missing. Per-id status returned; failures do not abort the batch. Pair with ' +
      'search_archives or archives_by_date_range to assemble the id list.',
    inputSchema: {
      ids: z.array(z.string()).min(1).describe('Archive ids to export.'),
      targetDir: z.string().describe('Output directory. Created recursively if missing.'),
      format: z.enum(['md', 'txt', 'json']).optional().describe('Output format. Default "md".'),
    },
  },
  wrap(async ({ ids, targetDir, format }) =>
    ok(await apiPost('/archive/bulk-export-text', { ids, targetDir, ...(format ? { format } : {}) })),
  ),
);

// ── recording lifecycle + audio devices (Wave W5, v1.4.0) ──────────────
//
// Deterministic start/stop verbs (vs. the legacy `toggle_recording` which
// flips whichever state the app is in). Both are idempotent — if the app
// is already in the requested state, the call returns ok with
// alreadyRecording / alreadyStopped set, without firing a duplicate
// transition. Microphone enumeration is exposed read-only; to switch
// devices, set engine.micDeviceId via set_setting / set_config.

server.registerTool(
  'start_recording',
  {
    description:
      'Begin a voice recording (mode-aware: batch / streaming / API engine). The actual ' +
      'mic-capture + WebSocket setup completes asynchronously after the call returns — ' +
      'poll get_recording_state to confirm the live state. Idempotent: if already ' +
      'recording, returns { ok: true, alreadyRecording: true } without firing a second start.',
  },
  wrap(async () => ok(await apiPost('/recording/start'))),
);

server.registerTool(
  'stop_recording',
  {
    description:
      'End the current recording and trigger the transcription + paste pipeline against ' +
      'the window that had focus when recording started. Idempotent: returns ' +
      '{ ok: true, alreadyStopped: true } if no recording is active.',
  },
  wrap(async () => ok(await apiPost('/recording/stop'))),
);

server.registerTool(
  'list_audio_devices',
  {
    description:
      'Enumerate audio input devices (microphones) available to Windy Word. Returns each ' +
      'device with { deviceId, label, groupId, isCurrent } plus the currently-selected ' +
      'micDeviceId and a hint when labels are hidden (the OS hides labels until mic ' +
      'permission has been granted at least once — the user must start a recording one ' +
      'time before labels become visible). To switch devices, call set_setting with ' +
      'path "engine.micDeviceId" and the desired deviceId.',
  },
  wrap(async () => ok(await apiGet('/audio/devices'))),
);

// ── account / billing / plan ────────────────────────────────────────────
// Thin proxies for the account-server (https://windyword.ai/api/v1/*).
// Grandma utterances these cover:
//   "what plan am i on"                  → get_my_plan
//   "show me my receipts"                → get_billing_history
//   "what does my bill look like"        → get_billing_summary
//   "upgrade me to pro"                  → open_upgrade_checkout
//   "manage my subscription / cancel"    → open_billing_portal
//   "sign me out"                        → logout_account
// All require a stored auth token (auth.token / auth.storageToken in the
// electron-store). When the user is signed out the local control server
// returns 401 with a structured {ok:false, error:"Not signed in ..."}.

server.registerTool(
  'get_my_plan',
  {
    description:
      'Return the signed-in user\'s identity and license tier — the answer to "what plan am I on", ' +
      '"what tier am I on", "am I a pro user", "what subscription do I have". Returns ' +
      '{ userId, name, email, tier, devices, deviceLimit, createdAt }. Tier is one of ' +
      '{free, pro, lifetime, team}. If the user is not signed in, returns ok:false with a ' +
      '"Not signed in" error — surface that to the user and offer to walk them through sign-in.',
  },
  wrap(async () => ok(await apiGet('/account/me'))),
);

server.registerTool(
  'get_billing_history',
  {
    description:
      'Return the user\'s purchase / transaction history — the answer to "show me my receipts", ' +
      '"what have I paid for", "list my transactions". Returns an array of transactions with ' +
      '{ id, tier, billing_type, amount_cents, currency, created_at, stripe_session_id }. ' +
      'Requires sign-in.',
  },
  wrap(async () => ok(await apiGet('/account/billing/transactions'))),
);

server.registerTool(
  'get_billing_summary',
  {
    description:
      'Return a high-level billing summary — current tier, lifetime spend, next renewal (if ' +
      'subscribed). Answer to "what does my bill look like", "billing summary", "how much have ' +
      'I spent on Windy Word". Requires sign-in.',
  },
  wrap(async () => ok(await apiGet('/account/billing/summary'))),
);

server.registerTool(
  'open_upgrade_checkout',
  {
    description:
      'Open a Stripe Checkout page in the user\'s default browser to upgrade to a paid tier. ' +
      'Use this for "upgrade me", "I want pro", "switch me to lifetime", "buy the yearly plan". ' +
      'Returns { ok, url, sessionId, opened } — `opened:true` means shell.openExternal launched ' +
      'the browser; tell the user to complete checkout there. tier must be one of ' +
      '{pro, translate, translate_pro}; billing_type must be one of {lifetime, monthly, yearly}. ' +
      'After checkout completes the user\'s tier updates via webhook — call get_my_plan to ' +
      'confirm. Requires sign-in.',
    inputSchema: {
      tier: z.enum(['pro', 'translate', 'translate_pro']).describe('Subscription tier the user wants to buy.'),
      billing_type: z.enum(['lifetime', 'monthly', 'yearly']).describe('Billing cadence. "lifetime" is a one-time payment; "monthly"/"yearly" are subscriptions.'),
    },
  },
  wrap(async ({ tier, billing_type }) => ok(await apiPost('/account/billing/checkout', { tier, billing_type }))),
);

server.registerTool(
  'open_billing_portal',
  {
    description:
      'Open the Stripe Customer Portal in the user\'s default browser. Use this for "manage my ' +
      'subscription", "update my credit card", "cancel my plan", "view my invoices", "I want a ' +
      'refund". Returns { ok, url, opened }. Cancellation, plan changes, and card updates all ' +
      'happen in the portal — the user must complete those steps there. Requires sign-in AND a ' +
      'prior purchase (account-server returns 400 if the user has never bought anything).',
  },
  wrap(async () => ok(await apiPost('/account/billing/portal'))),
);

server.registerTool(
  'logout_account',
  {
    description:
      'Sign the user out of their Windy account. Use this for "sign me out", "log me out", ' +
      '"switch accounts". Best-effort upstream logout, then ALWAYS clears the local auth + ' +
      'cached license fields (auth.token, auth.storageToken, license.tier, license.email, ' +
      'license.purchasedAt, license.expiresAt, license.stripeSessionId). Safe to call when ' +
      'already signed out and safe to call offline.',
  },
  wrap(async () => ok(await apiPost('/account/logout'))),
);

// ── TTS — the agent talks back ──────────────────────────────────────────
// Closes the half-conversation gap. Until now the user talked to the
// app and the app silently acted; with these three the agent can read
// back transcripts, confirm actions, or hold an eyes-free conversation.
// Cross-platform: mac /usr/bin/say, Windows System.Speech.Synthesis,
// Linux festival/espeak (must be installed).

server.registerTool(
  'speak_text',
  {
    description:
      'Speak text aloud through the OS\'s system TTS. Use this whenever the user can\'t see ' +
      'the screen — confirmations ("OK, I muted notifications"), read-backs ("here\'s your ' +
      'transcript: ..."), or eyes-free conversation. Returns 200 immediately after starting ' +
      'playback (does NOT block for audio duration). Default interrupt:true cancels any ' +
      'currently-playing TTS so a new utterance always wins; pass interrupt:false to queue. ' +
      'voice and rate are platform-specific — call list_tts_voices first if the user asks for ' +
      'a particular voice. Linux requires festival or espeak installed; failure returns a ' +
      'structured hint.',
    inputSchema: {
      text: z.string().min(1).max(5000).describe('Text to speak. Max 5000 chars; break longer messages into chunks.'),
      voice: z.string().optional().describe('Optional voice name (platform-specific, e.g. "Samantha" on macOS). Omit for OS default.'),
      rate: z.number().optional().describe('Optional speech rate. macOS: words-per-minute (default ~175). Omit for OS default.'),
      interrupt: z.boolean().optional().describe('If true (default) cancels any in-flight TTS before speaking. Set false to queue after current speech.'),
    },
  },
  wrap(async ({ text, voice, rate, interrupt }) => ok(await apiPost('/tts/speak', { text, voice, rate, interrupt }))),
);

server.registerTool(
  'stop_speaking',
  {
    description:
      'Silence any in-flight TTS playback immediately. Use this when the user says "stop", ' +
      '"shut up", "be quiet", or interrupts to ask something new. Safe to call when nothing ' +
      'is playing.',
  },
  wrap(async () => ok(await apiPost('/tts/stop'))),
);

server.registerTool(
  'list_tts_voices',
  {
    description:
      'List the system TTS voices installed on this machine. Returns platform-specific names ' +
      '(macOS: "Samantha", "Daniel", "Alex"; Windows: "Microsoft David Desktop"). Pass one of ' +
      'these as the `voice` argument to speak_text. Use this when the user asks "what voices ' +
      'do you have" or wants to switch the agent\'s voice.',
  },
  wrap(async () => ok(await apiGet('/tts/voices'))),
);

// ── settings: undo + audit log ──────────────────────────────────────────
// Safety net for voice-driven setting changes. Voice recognition is fuzzy
// — grandma says "make the volume louder" and the agent might overshoot.
// These two let her say "undo my last change" or "what did I just change"
// without leaving the conversation. History is in-memory, capped at 50
// entries, reset on app restart.

server.registerTool(
  'undo_last_setting_change',
  {
    description:
      'Revert the most recent catalog-validated setting change in this session. Use this when ' +
      'the user says "undo", "undo that", "put it back", "I didn\'t mean to change that", or ' +
      '"that was too loud, go back". Pops the last entry from the change history and replays ' +
      'the previousValue through the same apply path as set_setting (so hotkey re-registration, ' +
      'renderer live-apply, and engine hot-reload all fire correctly). Returns 404 with a clean ' +
      'error when there\'s nothing to undo. Cannot undo a /config raw write — only catalog-' +
      'validated changes (set_setting, set_theme, set_language, set_font_size, set_opacity, ' +
      'set_always_on_top, set_panel_visibility, set_analytics_enabled, set_hotkey, set_model).',
  },
  wrap(async () => ok(await apiPost('/settings/undo'))),
);

server.registerTool(
  'list_recent_setting_changes',
  {
    description:
      'List the catalog-validated setting changes made in this session, oldest first. The ' +
      'answer to "what did I just change", "what have I been changing", "show me my recent ' +
      'changes". Each entry: { path, previousValue, newValue, timestamp, source }. Bounded by ' +
      'a 50-entry ring buffer; oldest entries drop as new ones land. History resets on app ' +
      'restart.',
  },
  wrap(async () => ok(await apiGet('/settings/history'))),
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
