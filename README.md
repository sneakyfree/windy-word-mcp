# windy-word-mcp

An MCP (Model Context Protocol) server that turns [Windy Word](https://windyword.ai) — the voice-to-text desktop app — into an agent-controllable platform. **115 tools** spanning paste / hotkeys / transcription / recording verbs / audio devices / install / diagnostics / archive / voice clones / translation / documents / system / window / account + billing / TTS / settings-undo / music-ducking / bulk-clone-ingest / soul-file export.

Windy Word ships a local HTTP control server on `127.0.0.1:18765`. This package is a schema-validated MCP wrapper around it. Agents call MCP tools; the server forwards to Windy Word over localhost; everything happens on the user's machine (no network round-trips for state queries).

[![npm](https://img.shields.io/npm/v/windy-word-mcp.svg)](https://www.npmjs.com/package/windy-word-mcp)
[![mcp registry](https://img.shields.io/badge/mcp%20registry-active-brightgreen)](https://registry.modelcontextprotocol.io)

---

## Install

For most users:

```bash
claude mcp add windy-word --command "npx" --args "-y" "windy-word-mcp"
```

Or in `~/.claude.json` / `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "windy-word": {
      "command": "npx",
      "args": ["-y", "windy-word-mcp"]
    }
  }
}
```

Local-dev (cloned repo):

```bash
git clone https://github.com/sneakyfree/windy-word-mcp && cd windy-word-mcp
npm install
claude mcp add windy-word --command "node" --args "$(pwd)/bin/windy-word-mcp.js"
```

## Requirements

- Node.js ≥ 18
- Windy Word running locally (Electron app — the HTTP control server binds automatically at startup)

## Environment overrides

| Variable | Default | Purpose |
|---|---|---|
| `WINDY_WORD_MCP_HOST` | `127.0.0.1` | Override the control-server host |
| `WINDY_WORD_MCP_PORT` | `18765` | Override the control-server port |
| `WINDY_WORD_MCP_TIMEOUT_MS` | `5000` | Default per-request timeout (the install + transcribe tools override this internally for long ops) |

---

## Tool catalog (115 tools, 22 categories)

> Regenerate this section's tool count any time with `npm run test:list-tools`
> (`node scripts/list-tools.js`), which enumerates the live server's registered tools.

### Platform (1)
| Tool | What it does |
|---|---|
| `get_platform` | OS, arch, distro, display server, desktop env, xdotool/ydotool presence |

### Paste strategies (9)
12 platform-specific paste backends (macOS / Windows / Linux X11 / Linux Wayland) with capability metadata, hotkey-collision auto-detection, and a verified fallback chain.

| Tool | What it does |
|---|---|
| `list_paste_strategies` | All 12 strategies + per-strategy availability + resolved chain + collision flag |
| `get_active_paste_strategy` | Current selection + resolved chain |
| `set_paste_strategy` | Switch active (or `"auto"`) |
| `test_paste_strategy` | Fire a specific strategy at the focused window (injects text!) |
| `auto_paste` | Run the auto-execute chain with explicit candidates |
| `run_paste_injection_test` | Real end-to-end test — spawns Tk target, fires paste, diffs result |
| `get_paste_history` / `clear_paste_history` | In-memory audit log |
| `get_paste_target` | XWayland vs Wayland-native detection |

### Hotkeys (3)
| Tool | What it does |
|---|---|
| `list_hotkeys` | Current bindings + available actions + reserved combos |
| `set_hotkey` | Rebind a global shortcut (Electron accelerator format) |
| `reset_hotkeys` | Restore all global shortcuts to catalog defaults + re-register |

### Transcription engine (3)
| Tool | What it does |
|---|---|
| `list_models` | Whisper model catalog + current + WindyTune ladder |
| `set_model` | Switch (hot-reloads Python engine over WebSocket) |
| `get_windytune_state` | Auto-tune state, ladder, recent-timing history |

### Recording verbs (8)
| Tool | What it does |
|---|---|
| `start_recording` | Begin a mode-aware recording (batch / streaming / API engine) |
| `stop_recording` | End the recording → trigger transcription + paste pipeline |
| `cancel_recording` | Abort an in-flight recording without saving |
| `get_recording_state` | isRecording + pythonEngineRunning + mode snapshot |
| `toggle_recording` | Start/stop (same effect as the global hotkey) |
| `paste_transcript` | Re-paste the most recent transcript |
| `set_language` | Set the Whisper transcription language (ISO 639-1) |
| `set_panel_visibility` | Configure a bottom panel row (`always` / `hover` / off) |

### Audio devices (1)
| Tool | What it does |
|---|---|
| `list_audio_devices` | Enumerate microphones available to Windy Word |

### `install_dependency` family (8)
Agent installs missing system tools (Linux/macOS/Windows package managers). Linux uses `pkexec`; macOS uses user-scope `brew`; Windows uses `winget`. Whitelist-only: `wtype`, `ydotool`, `wl-clipboard`, `xdotool`, `cliclick`, `ffmpeg`.

| Tool | What it does |
|---|---|
| `list_installable_dependencies` | What's installable on this machine right now |
| `install_dependency` | Synchronous install (whitelist + dryRun) |
| `install_dependency_async` | Fire-and-poll variant — returns jobId |
| `get_install_status` | Poll a job |
| `list_install_jobs` | All in-memory jobs |
| `get_install_history` / `clear_install_history` | Audit log |
| `setup_install_polkit_rule` | Install/remove the Linux polkit auto-approve rule |

**Polkit setup (Linux):** `setup_install_polkit_rule` installs `/etc/polkit-1/rules.d/49-windy-install-deps.rules` once per machine to make installs prompt-free. See [the rule snippet](./PUBLISHING.md#polkit-rule-for-linux-install-without-prompts).

### Windy Doctor — local + cloud (3)
**13 local rule-based checks** covering paste-stack tooling, `/dev/uinput` permissions, polkit rule presence (with EACCES-tolerant detection), Python engine liveness, Mutter hotkey collision, macOS Accessibility + Microphone permissions, Homebrew presence, cliclick presence.

| Tool | What it does |
|---|---|
| `run_diagnostics` | Run the local battery; return structured findings + actionable remediations |
| `list_diagnostic_checks` | What checks exist + which apply to this platform |
| `cloud_diagnose` | LLM-augment via the `windy-fix-me` Cloudflare Worker (Claude Haiku 4.5 via OpenRouter) |

### Settings catalog (5) — typed/validated agent surface
49 typed catalog entries with tags (`archive`, `voice-clone`, `transcription`, `paste`, `hotkey`, `ui`, `geometry`, `lifecycle`, `license`). Validation runs server-side before any write.

| Tool | What it does |
|---|---|
| `list_settings` | Catalog + current live values + available tags. Supports `?tag=X` filter |
| `describe_setting` | Single entry + current value |
| `set_setting` | Validate + apply + return side effects |
| `get_config` | Full electron-store dump (low-level escape hatch) |
| `set_config` | Patch by dotted path, no validation (low-level escape hatch) |

### Settings undo (2)
| Tool | What it does |
|---|---|
| `undo_last_setting_change` | Revert the most recent catalog-validated setting change this session |
| `list_recent_setting_changes` | List session setting changes, oldest first |

### Archive surface (8) — opaque-id session catalog
Agents work with opaque `arc:YYYY-MM-DD:HHMMSS.md` ids, never filesystem paths. Path-confined deletes.

| Tool | What it does |
|---|---|
| `list_archive_entries` | List recordings with transcripts + metadata |
| `get_archive_stats` | totalFiles/sizeMB/days/words/sessions (30s server-side cache) |
| `read_archive_entry` | Base64 audio or video for an entry |
| `delete_archive_entry` | Tear down md + audio + video |
| `open_archive_folder` | Pop OS file manager at the archive root |
| `search_archives` | Full-text substring search across every transcript |
| `archives_by_date_range` | Sessions whose start timestamp falls within `[from, to]` |
| `bulk_delete_archives` | Tear down multiple entries in one call |

### Voice clones (10 — Phase 1 + Phase 2)
| Tool | What it does |
|---|---|
| `list_voice_clones` | All clones + activeId (no audio bytes) |
| `get_active_voice_clone` | Currently-active clone (or null) |
| `set_active_voice_clone` | Switch active (or deactivate with `null`) |
| `create_voice_clone_from_path` | Create from an audio file on disk (path-confined copy) |
| `delete_voice_clone` | Irreversible teardown |
| `preview_voice_clone` | Metadata + optional base64 audio |
| `list_clone_bundles` | Training-bundle catalog |
| `submit_voice_clone_to_cloud` | Submit a local clone to Windy Clone for ElevenLabs training |
| `get_cloud_clone_order_status` | Poll Windy Clone for ElevenLabs training progress |
| `bulk_ingest_to_clone` | Copy a batch of audio files into the voice-samples store as clones |

### Bulk clone ingest + watchers (3)
| Tool | What it does |
|---|---|
| `scan_folder_for_media` | Scan a folder (recursive) for audio + video files |
| `watch_folder_for_recordings` | Start/stop a folder watcher that auto-ingests new audio |
| `list_clone_watchers` | List active folder watchers |

### Translation (5)
| Tool | What it does |
|---|---|
| `translate_text` | TM-cache-first → Groq/OpenAI fallback (auto-populates cache) |
| `lookup_translation_memory` | Local cache query, no API |
| `save_translation_memory` | Manual upsert |
| `get_translation_memory_stats` | Total / topPairs / recentEntries |
| `clear_translation_memory` | Wipe (destructive) |

### Documents (3)
| Tool | What it does |
|---|---|
| `extract_document_text` | Path-based, supports txt/md/csv/html/pdf/docx (5MB default, 20MB cap) |
| `save_text_file` | Path-based write; refuses overwrite unless flagged |
| `transcribe_audio_file` | Any audio file → Whisper transcript via warm WebSocket engine (~5× real-time on CPU) |

### Sound effects (7)
| Tool | What it does |
|---|---|
| `get_sound_effect_state` | Per-hook-stage enabled/volume settings (6 lifecycle stages) |
| `set_sound_hook` | Configure a single sound-effect hook stage |
| `set_active_sound_pack` | Switch the active sound pack |
| `set_master_sfx_volume` | Set master SFX volume (0-100) |
| `set_sound_effect_mode` | Switch EffectsEngine mode (silent / classic / surprise / custom / pack) |
| `list_sound_effect_packs` | List known sound-effect packs |
| `get_widget_state` | Mini-widget (tornado) runtime state via the renderer bridge |

### System utilities (3) + Forma Animae (1)
| Tool | What it does |
|---|---|
| `detect_hardware` | RAM, CPU, GPU (nvidia-smi + Apple Silicon detect), disk free |
| `get_autostart_status` | Is Windy Word configured to launch on login |
| `set_autostart` | Toggle login-item / .desktop entry |
| `export_soul_file_to_path` | Forma Animae: zip the whole archive (audio + video + transcripts + manifest) for the digital-twin pipeline |

### Window + app lifecycle (16)
| Tool | What it does |
|---|---|
| `get_window_state` | Snapshot of maximized/minimized/focused/visible/fullScreen |
| `minimize_window` / `maximize_window` / `unmaximize_window` | Title-bar window controls |
| `bring_window_to_front` | Restore + show + raise (does not steal keyboard focus) |
| `set_window_geometry` | Set position + size in screen pixels (live + persisted) |
| `set_video_fullscreen` | Toggle native OS-level fullscreen |
| `set_always_on_top` | Keep the window above others |
| `set_opacity` | Set window opacity (0.1-1.0) |
| `set_theme` | dark / light / auto |
| `set_font_size` | UI zoom factor (70-150%) |
| `show_hide_window` | Cycle main → tornado → hidden → main |
| `quick_translate` | Open the Quick Translate mini-window |
| `restart_app` / `quit_app` | Relaunch / quit Windy Word (destructive) |

### App info + notifications (5)
| Tool | What it does |
|---|---|
| `get_version` | Windy Word + Electron + Node versions |
| `check_for_updates` | Trigger electron-updater's update check |
| `set_analytics_enabled` | Opt in/out of anonymous usage analytics |
| `open_url` | Open an http/https URL or a Windy ecosystem scheme |
| `send_notification` | Show an OS-native notification |

### Account + billing (6)
| Tool | What it does |
|---|---|
| `get_my_plan` | Signed-in identity + license tier |
| `get_billing_history` | Purchase / transaction history |
| `get_billing_summary` | Tier + lifetime spend + next renewal |
| `open_upgrade_checkout` | Open Stripe Checkout for an upgrade |
| `open_billing_portal` | Open the Stripe Customer Portal |
| `logout_account` | Sign the user out |

### TTS (3)
| Tool | What it does |
|---|---|
| `speak_text` | Speak text aloud through the OS system TTS |
| `stop_speaking` | Silence in-flight TTS playback |
| `list_tts_voices` | List installed system TTS voices |

### Music ducking (2)
| Tool | What it does |
|---|---|
| `pause_other_audio` | Pause music/media in other apps (Spotify, Apple Music, browsers, VLC) |
| `resume_other_audio` | Resume what `pause_other_audio` paused |

---

## Architecture

```
┌──────────────────────────┐
│  Agent (Claude Code etc) │
└──────────┬───────────────┘
           │ MCP over stdio
           ▼
┌─────────────────────────────────────────┐
│  windy-word-mcp (this package)          │
│  - 115 zod-validated tool schemas       │
│  - Per-tool timeout overrides           │
│  - Structured 4xx body pass-through     │
│  - "Windy Word not running" detection   │
└──────────┬──────────────────────────────┘
           │ HTTP localhost:18765
           ▼
┌─────────────────────────────────────────┐
│  Windy Word (Electron) — windy-pro repo │
│  - 49-entry settings catalog            │
│  - 13 Doctor checks                     │
│  - Paste-strategy registry (12 backends)│
│  - Whisper Python engine (WebSocket)    │
│  - Voice clone + archive on-disk state  │
└──────────┬──────────────────────────────┘
           │ HTTPS (only for cloud-diagnose)
           ▼
┌─────────────────────────────────────────┐
│  windy-fix-me CF Worker                 │
│  - SHARED_SECRET auth                   │
│  - 20 req/IP/min rate limit             │
│  - Claude Haiku 4.5 via OpenRouter      │
└─────────────────────────────────────────┘
```

## Coverage

**115 MCP tools** now surface the Windy Word desktop app's agent-control surface — paste, hotkeys, transcription, recording verbs, audio devices, install/Doctor, archive, voice clones (Phase 1 + Phase 2 cloud training), translation, documents, sound effects, window + app lifecycle, account + billing, TTS, settings-undo, music-ducking, bulk-clone-ingest, and soul-file export. Internal renderer events that are not agent-callable RPCs by design are intentionally excluded.

## Quality bar

`scripts/stress-test.js` exercises every safe tool, including:
- Whitelist rejection at the MCP zod layer
- Structured 4xx error pass-through for validation failures
- Cross-OS rejection (cliclick on Linux, wtype on macOS)
- Real paste injection round-trip (Tk capture + diff)
- Concurrency burst (20 parallel `get_platform` calls)
- Idempotent installs (alreadyInstalled detection)

**67/67 passing** at v1.0.0 release.

Known intermittent: `run_paste_injection_test` ~1-in-5 hits a Mutter focus-handoff race on Wayland+GNOME. Re-run is clean. Not a regression.

## Sibling components

These are private repositories — the names are here so the architecture reads clearly, not as links.

- **`windy-pro`** — the Electron app (Windy Word). Contains the control server, settings catalog, install registry, Doctor checks, paste strategies, archive scanner, voice-clone CRUD.
- **`windy-fix-me`** — the cloud-relay Cloudflare Worker. Receives Doctor findings + platform context, returns LLM-augmented remediation.

This server is the public, supported interface to Windy Word. You do not need either of the above to use it — install from npm as shown at the top.

## Version history

See [CHANGELOG.md](./CHANGELOG.md) for the per-version details. Tool count progression:

```
v0.1.0  20    foundation
v0.2.0  24    install_dependency + polkit auto-approve
v0.3.0  27    settings catalog
v0.4.0  33    async install + Windy Doctor + cross-platform
v0.5.0  34    cloud_diagnose
v0.6.0  35    paste injection + tag filter
v0.7.0  41    voice clones Phase 1
v0.8.0  46    archive surface
v0.9.0  53    translation + documents
v0.10.0 56    utilities + OC5 macOS Doctor merge
v0.11.0 57    transcribe_audio_file
v0.12.0 60    soul-file export + voice-clone Phase 2 starters
v1.0.0  60    stable API surface declared
v1.5.0  95    Waves W1–W6: window/state, archive search, lifecycle, recording verbs, cloud submit
v1.6.0  104   account / billing / plan surface
v1.7.0  107   TTS round-trip
v1.8.0  109   settings undo + audit log
v1.9.0  111   music ducking
v1.10.0 115   bulk clone-ingest
```

## License

MIT. See [LICENSE](./LICENSE).

## Contributing

Bug reports + tool additions welcome. See [PUBLISHING.md](./PUBLISHING.md) for the release recipe.
