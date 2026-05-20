# windy-word-mcp

An MCP (Model Context Protocol) server that exposes the [Windy Word](https://windyword.ai) desktop app's agent-control surface — paste strategies, hotkeys, transcription models, configuration, and action triggers — as tools any MCP-aware agent (Claude Code, Claude Desktop, etc.) can call.

Windy Word already runs a local HTTP control server on `127.0.0.1:18765`. This MCP server is a thin, schema-validated wrapper over that surface so agents don't have to know about the port, the endpoint shapes, or the failure modes (e.g. "Windy Word isn't running").

## Requirements

- Node.js ≥ 18
- Windy Word running locally (the desktop app exposes the HTTP control server on `127.0.0.1:18765` automatically)

## Install

```bash
git clone https://github.com/sneakyfree/windy-word-mcp.git
cd windy-word-mcp
npm install
```

Add it to Claude Code:

```bash
claude mcp add windy-word --command "node /absolute/path/to/windy-word-mcp/bin/windy-word-mcp.js"
```

Or in `~/.claude.json` / `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "windy-word": {
      "command": "node",
      "args": ["/absolute/path/to/windy-word-mcp/bin/windy-word-mcp.js"]
    }
  }
}
```

## Environment variables (optional)

| Variable                       | Default       | Meaning                                            |
| ------------------------------ | ------------- | -------------------------------------------------- |
| `WINDY_WORD_MCP_HOST`          | `127.0.0.1`   | Host the Windy Word control server is bound to.    |
| `WINDY_WORD_MCP_PORT`          | `18765`       | Control-server port.                               |
| `WINDY_WORD_MCP_TIMEOUT_MS`    | `5000`        | Per-request timeout to the control server.         |

## Tool catalog

**Platform**

- `get_platform` — OS / arch / distro / display server / desktop / xdotool & ydotool availability.

**Paste strategy registry**

- `list_paste_strategies` — all 12 strategies with capability metadata, per-machine availability, default chain, and a `hotkeyCollisionDetected` flag (Mutter intercepting Windy Word's own Ctrl+Shift+V).
- `get_active_paste_strategy` — selection + resolved fallback chain.
- `set_paste_strategy` — change strategy (or `"auto"`) and optionally override the chain.
- `test_paste_strategy` — fire a test paste with a specific strategy. **Injects text into the focused window** — focus a known-safe target first.
- `auto_paste` — run the auto-execute chain with explicit candidates. **Injects text.**
- `get_paste_history` — last N attempts with timestamp, length, hash (not text), chain, winner, target type.
- `clear_paste_history` — reset the buffer.
- `get_paste_target` — XWayland vs Wayland-native vs unknown for the currently focused window.

**Hotkeys**

- `list_hotkeys` — current bindings, rebindable actions, reserved accelerators.
- `set_hotkey` — rebind one action (Electron accelerator format).

**Transcription engine**

- `list_models` — current model + WindyTune ladder + size/speed/accuracy table.
- `set_model` — switch the active Whisper model (hot-reloads the Python engine over WebSocket).
- `get_windytune_state` — auto-tune state, history, thresholds, rolling avg ratio.

**Config**

- `get_config` — full electron-store dump.
- `set_config` — patch a single dotted path (`{path, value}`) or a flat object of paths (`{patch}`).

**Action triggers (parity with the global hotkeys)**

- `toggle_recording`
- `paste_transcript`
- `show_hide_window`
- `quick_translate`

## Failure mode

If Windy Word isn't running, every tool returns a friendly error pointing at how to start it. The MCP server itself stays alive — start Windy Word and retry the tool without restarting the agent.

## License

MIT. See [LICENSE](LICENSE).
