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

const SERVER_VERSION = '0.1.0';

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

// Wrap a handler so WindyWordClientError surfaces as a friendly tool error
// instead of an unhandled rejection (which the SDK would turn into a generic
// internal error). Anything else still propagates.
function wrap(handler) {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (e) {
      if (e instanceof WindyWordClientError) return err(e.message);
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

// ── config ───────────────────────────────────────────────────────────────

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
