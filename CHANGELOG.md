# Changelog

All notable changes to `windy-word-mcp`. SemVer 2.0.0.

## [1.7.0] — 2026-05-21

**TTS round-trip — the agent talks back.** +3 tools. Total: **107**.

Closes the half-conversation gap: until now the user talked to the app and the app silently acted. With these the agent can read back transcripts, confirm actions ("OK, I muted notifications"), or hold an eyes-free conversation while grandma's hands are busy. Cross-platform via the `say` npm: macOS `/usr/bin/say`, Windows `System.Speech.Synthesis`, Linux `festival` or `espeak` (must be installed; structured error hint on failure).

- `speak_text(text, voice?, rate?, interrupt?)` — proxies `POST /tts/speak`. Returns 200 immediately after starting playback; default `interrupt:true` cancels any in-flight TTS so a new utterance always wins. Max 5000 chars per call.
- `stop_speaking` — proxies `POST /tts/stop`. Safe to call when nothing is playing.
- `list_tts_voices` — proxies `GET /tts/voices`. Returns platform-specific voice names (macOS "Samantha", Windows "Microsoft David Desktop", etc).

Companion `windy-pro` merge: PR `feat/tts-speak-text` (adds three `/tts/*` HTTP routes; new dep `say@^0.16.0`).

## [1.6.0] — 2026-05-21

**Account / billing / plan surface.** +6 tools. Total: **104**.

Closes the largest grandma-utterance gap: until now the MCP surface controlled only the local Electron app, never the account-server. With these tools an agent can answer "what plan am I on?", show purchase history, open the Stripe upgrade flow or Customer Portal, and sign the user out — all by voice, no menus.

- `get_my_plan` — proxies `GET /api/v1/auth/me`. Returns identity + tier.
- `get_billing_history` — proxies `GET /api/v1/billing/transactions`.
- `get_billing_summary` — proxies `GET /api/v1/billing/summary`.
- `open_upgrade_checkout(tier, billing_type)` — proxies `POST /api/v1/stripe/create-checkout-session`, then opens the URL via `shell.openExternal`. Zod-validated: tier ∈ {pro, translate, translate_pro}, billing_type ∈ {lifetime, monthly, yearly}.
- `open_billing_portal` — proxies `POST /api/v1/stripe/create-portal-session`, then opens the URL.
- `logout_account` — best-effort upstream `POST /api/v1/auth/logout`, then clears local `auth.token`, `auth.storageToken`, `license.tier`, `license.email`, `license.purchasedAt`, `license.expiresAt`, `license.stripeSessionId`. Safe offline.

All six require sign-in (return structured `{ok:false, error:"Not signed in ..."}` with 401 when `auth.token` is missing) except `logout_account`, which is safe to call when already signed out. Companion `windy-pro` merge: PR `feat/account-mcp-billing` (adds six `/account/*` HTTP routes + `ACCOUNT_API_DEFAULT_URL` constant).

## [1.5.0] — 2026-05-21

**Waves W1 → W6 — full agent-control surface.** +23 tools. Total: **95**.

- **Wave W1 (window + state observability, 9 tools):** `get_window_state`, `minimize_window`, `maximize_window`, `unmaximize_window`, `bring_window_to_front`, `set_window_geometry`, `set_font_size`, `set_video_fullscreen`, `get_recording_state`.
- **Wave W2 (archive search + bulk-delete, 3 tools):** `search_archives`, `archives_by_date_range`, `bulk_delete_archives` (YES-DELETE-N confirm guard).
- **Wave W4/W2 cont'd (lifecycle + bulk-export, 7 tools):** `cancel_recording`, `restart_app`, `quit_app`, `set_always_on_top`, `set_opacity`, `send_notification`, `bulk_export_archives_text`.
- **Wave W5 (recording verbs + audio devices, 3 tools):** `start_recording`, `stop_recording`, `list_audio_devices` — closes the "Hey agent, start recording" grandma-demo gap.
- **Wave W6 (voice clone cloud submit, 1 tool):** `submit_voice_clone_to_cloud` — completes the create → submit → poll training arc.

Companion windy-pro merges land the corresponding HTTP control-plane endpoints (PRs #143, #148-#151, #153-#155, #157-#158).

## [1.0.0] — 2026-05-20

**Stable API surface declared.** No new tools — this release consolidates the surface built in v0.1.0 through v0.12.0. Tool names, input schemas, and response shapes are committed to as stable. Future 1.x releases add new tools without breaking existing ones. Breaking changes will go to 2.0.0.

- README expanded with full 60-tool catalog organized by category
- CHANGELOG.md added (this file) spanning the full v0.1.0 → v1.0.0 arc
- No code changes

## [0.12.0] — 2026-05-20

- **+3 tools.** Total: 60.
- `export_soul_file_to_path` — Forma Animae artifact creation, path-based variant of the dialog-driven export-soul-file IPC. Verified live: 1.5GB / 968 files / 158k words / 30 days exported in 177s on Windy 0.
- `create_voice_clone_from_path` — voice-clone Phase 2 starter; copies a source audio file into vcAudioDir, registers in the JSON DB.
- `get_cloud_clone_order_status` — poll Windy Clone for ElevenLabs training progress on a submitted order.

## [0.11.0] — 2026-05-20

- **+1 tool.** Total: 57.
- `transcribe_audio_file` — path-based variant of batch-transcribe-local. Auto-detects audio format via ffmpeg (wav/mp3/m4a/ogg/flac/webm/etc), routes through the WebSocket-warm Python Whisper engine. 5× real-time on i7-7700K + "small" model. Verified live with a real 127s archived recording transcribed in 25s.

## [0.10.0] — 2026-05-20

- **+3 tools.** Total: 56. Plus OC5 parallel-session merges.
- `detect_hardware`, `get_autostart_status`, `set_autostart` — system info for model selection + boot-launch toggle (Linux .desktop entry; macOS/Windows via Electron's setLoginItemSettings).
- **OC5 merges:** `feat/macos-doctor-checks-oc5` (4 macOS Doctor checks: homebrew_installed, cliclick_installed, accessibility_permission_granted, microphone_permission_granted — Doctor catalog 9 → 13 checks) + `fix/install-dryrun-honors-already-installed` (dryRun returns command + alreadyInstalled flag together).

## [0.9.0] — 2026-05-20

- **+7 tools.** Total: 53.
- Translation: `translate_text`, `lookup_translation_memory`, `save_translation_memory`, `get_translation_memory_stats`, `clear_translation_memory`. translate_text is TM-cache-first; falls through to Groq/OpenAI on miss. Extracted `translateViaAI()` helper in windy-pro for shared IPC + HTTP path.
- Documents: `extract_document_text`, `save_text_file` — path-based variants of the dialog-based IPCs. txt/md/csv/html/pdf/docx, 5MB default cap, refuses overwrite without flag.

## [0.8.0] — 2026-05-20

- **+5 tools.** Total: 46.
- Archive surface: `list_archive_entries`, `get_archive_stats`, `read_archive_entry`, `delete_archive_entry`, `open_archive_folder`. Opaque-id design (`arc:YYYY-MM-DD:HHMMSS.md`) so agents never see filesystem paths. Helpers `_agentArchiveScan` + `_agentResolveArchiveId` in windy-pro enforce path-confinement. Live on Windy 0: 780 sessions / 30 days / 78k words.

## [0.7.0] — 2026-05-20

- **+6 tools.** Total: 41.
- Voice clones Phase 1: `list_voice_clones`, `get_active_voice_clone`, `set_active_voice_clone`, `delete_voice_clone`, `preview_voice_clone`, `list_clone_bundles`. Read + manage; deferred Phase 2 (create / train / cloud-sync) due to UI dialogs + auth complications.

## [0.6.0] — 2026-05-20

- **+1 tool.** Total: 35.
- `run_paste_injection_test` — real end-to-end paste test. Spawns a Tk capture target, flips Mutter `focus-new-windows` to `strict` temporarily, fires the strategy, captures + diffs. Wayland+GNOME only in v0. Live result: `match=true, captured="STRESS-TEST-INJECT"`.
- Catalog tag filter: `list_settings({tag: "voice-clone"})` returns the subset of settings driving InstaBio voice-clone training behavior.
- `windy-fix-me` worker hardening: `SHARED_SECRET` auth deployed (lockbox has the value); 20 req/IP/60s per-isolate rate limit; `WINDY_FIX_ME_KEY` env-var auto-forwarding on the windy-pro side.

## [0.5.0] — 2026-05-20

- **+1 tool.** Total: 34.
- `cloud_diagnose` — local Doctor findings routed to the **`windy-fix-me` cloud-relay** (deployed live this version to `windy-fix-me.windyword.workers.dev`). Cloudflare Worker; Claude Haiku 4.5 via OpenRouter. ~1.7s round-trip, ~$0.002 per call.

## [0.4.0] — 2026-05-20

- **+6 tools.** Total: 33.
- Settings catalog expansion (27 → 40 entries) with archive/window/internal-readonly additions and a tags taxonomy.
- Cross-platform `install_dependency`: TOOL_WHITELIST restructured for per-OS install metadata. Linux (pkexec + dnf/apt/pacman), macOS (brew), Windows (winget). Added `cliclick` (macOS) and `ffmpeg` (cross-platform).
- Async install: `install_dependency_async`, `get_install_status`, `list_install_jobs` — fire-and-poll for long installs.
- **Windy Doctor (local)**: `run_diagnostics`, `list_diagnostic_checks` — 9 rule-based checks covering paste stack, /dev/uinput, polkit rule, Python engine, Mutter hotkey collision.

## [0.3.0] — 2026-05-20

- **+3 tools.** Total: 27.
- Settings catalog: `list_settings`, `describe_setting`, `set_setting`. 27 initial typed/validated entries with type / enum / range / sideEffect / restartRequired / sensitivity metadata. `get_config` / `set_config` remain as low-level escape hatches.
- **Structured-error pass-through:** the MCP client now surfaces 4xx JSON bodies (validation failures, not-found, refuse-to-overwrite) as the tool response instead of swallowing them into plain-text errors.

## [0.2.0] — 2026-05-20

- **+4 tools.** Total: 24.
- `install_dependency` family: `list_installable_dependencies`, `install_dependency`, `get_install_history`, `clear_install_history`. Whitelist (wtype, ydotool, wl-clipboard, xdotool), pkexec-wrapped distro installs (dnf/apt/pacman).
- **Polkit auto-approve rule** installed on Windy 0 at `/etc/polkit-1/rules.d/49-windy-install-deps.rules` so install_dependency runs prompt-free. wtype installed live this version via the agent path with zero polkit dialogs.

## [0.1.0 → 0.1.1] — 2026-05-20

- **Foundation: 20 tools.**
- MCP server scaffold via `@modelcontextprotocol/sdk` 1.29.
- Tools wrap the existing Windy Word HTTP control surface (port 18765): platform info, paste strategy registry (9 tools), hotkeys (2), transcription models + WindyTune (3), config get/set (2), action triggers (4).
- v0.1.1 added the `mcpName` field to package.json for MCP registry ownership verification; cleaned up the description for the 100-char registry constraint.
- Published live to npm + the MCP registry (`io.github.sneakyfree/windy-word-mcp`).

---

## Cross-cutting design decisions

These hold across all versions and won't change in 1.x:

- **Opaque ids over paths.** Archive entries, voice clones, and install jobs use opaque ids. Agents never see filesystem paths. Resolution happens server-side with explicit `path.resolve(...).startsWith(safeRoot)` confinement checks.
- **Whitelist over allow-everything.** install_dependency, paste strategies, hotkey actions, setting-mutation paths — all are constrained at the MCP zod layer + server-side re-validated.
- **Structured errors.** 4xx responses with JSON bodies pass through unchanged. Agents see `{ok: false, error: "..."}` for validation failures, never error-as-string.
- **Per-tool timeout overrides.** Long ops (install, transcribe, soul-file export) carry their own multi-minute timeouts; the default 5s applies to state queries.
- **Internal events stay internal.** ~30 IPC handlers are renderer-to-main lifecycle events (recording-failed, voice-level, video-frame-to-preview, mini-widget-move). These are NOT exposed as MCP tools by design.
- **Sensitive actions require explicit consent.** Billing flow (create-checkout-session, apply-coupon, store-license-token) is deliberately not in the agent surface yet. The shape would need a "user-confirmed" flag the agent can't fake.
