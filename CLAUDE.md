# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AntBot（搬运蚁）is an Electron desktop app for video automation: download → subtitle generation → editing/dubbing → publishing.

## Build & Run

```bash
npm install                    # installs deps + playwright chromium
npm run dev                    # run locally
npm run build:mac              # macOS DMG → release/
npm run build:win              # Windows NSIS
```

The `postinstall` hook runs `playwright install chromium`. The build script runs `prepare:icon:mac` and `prepare:voicebox` before `electron-builder`.

## Architecture

**Electron two-process model:**
- **Main process** (`src/main/`) — all business logic, IPC handlers, service modules
- **Renderer** (`src/renderer/`) — UI only, communicates via `window.antbot` bridge
- **Preload** (`src/main/preload.js`) — `contextBridge.exposeInMainWorld('antbot', {...})` maps IPC channels

**IPC pattern:** Renderer calls `window.antbot.methodName()` → `ipcRenderer.invoke(channel)` → `ipcMain.handle(channel)` in `ipc.js`. Push events: `webContents.send(channel)` → `ipcRenderer.on(channel)` via preload `on()` helper.

**Smart edit pipeline (two-phase):**
```
prepareEditVideo (smartEditor.js)     →  { srtContent, srtPath, videoName, tmpDir }
  extractFrames → AI Vision → generateSrt → generateVideoName

composeEditVideo (smartEditor.js)     →  { outputPath }
  delegates to editVideo (editor.js) → processWithAutoDub (autoDubClient.js)
```

**Edit scheduler** (`editScheduler.js`): manages task lifecycle with states `pending → preparing → ready → composing → completed`. Preparation runs up to 2 concurrently; composition runs sequentially. State persisted to `~/AntBot/edit-tasks.json`.

**Voicebox backend** (Python, port 17493): TTS engine. Started by `autoDubClient.js`. Data stored at `~/AntBot/voicebox-data/` (fixed path, survives project rebuilds). Venv at `~/AntBot/voicebox-env/.venv-voicebox/`.

**auto_dub_web** (Node.js, port 5001): video composition server at `vendors/auto_dub_web/server.mjs`. Handles TTS synthesis + subtitle burning + audio mixing.

## Key Paths

| Path | Purpose |
|------|---------|
| `~/AntBot/` | All user data (settings, history, logs, models, voicebox) |
| `~/AntBot/logs/app-*.log` | Per-launch log files (7-day auto-clean) |
| `~/AntBot/edit-tasks.json` | Edit task state persistence |
| `~/AntBot/voices.json` | Voice profiles (synced with voicebox backend) |
| `~/AntBot/api-usage.json` | API key daily usage tracking |

## Critical Rules

- **Module docs:** Read `docs/modules/*.md` before modifying any service module. Update the doc after changing module behavior.
- **No gradients:** CSS uses solid colors only. Theme color `var(--brand)` only on key interactive elements.
- **No `File.path`:** Electron 35 deprecated it. Use `window.antbot.getPathForFile(file)` (exposes `webUtils.getPathForFile`).
- **ffmpeg/ffprobe path resolution:** App runs from Electron where `/opt/homebrew/bin` may not be in PATH. Always use `resolveFfmpegBin()` pattern (check `/opt/homebrew/bin`, `/usr/local/bin`, then bare name).
- **Spawn args:** Never concatenate flags with values in a single string (e.g., `'-q:v 3'` → split to `'-q:v', '3'`). ffmpeg receives it as one arg and fails with exit 234.
- **Voicebox lifecycle:** Must call `shutdownVoicebox()` after composition completes (success or failure) to release ~37GB memory from the TTS model.
- **Data directory consistency:** voicebox venv at `~/AntBot/voicebox-env/`, voicebox data at `~/AntBot/voicebox-data/`. Both use `path.join(os.homedir(), 'AntBot')`, NOT `app.getPath('userData')`.
- **Settings auto-save:** `fillForm()` rebuilds DOM from `S.settings`. Any dynamic DOM (added inputs, etc.) will be destroyed. Don't call `saveSettings()` immediately after DOM mutations.

## Service Modules Quick Reference

| Module | Key Function | Notes |
|--------|-------------|-------|
| `smartEditor.js` | `prepareEditVideo`, `composeEditVideo` | AI frame extraction uses Vision API; composition delegates to `editVideo` |
| `editScheduler.js` | `EditScheduler` class | Pipeline: 2 concurrent prepares, 1 sequential compose |
| `autoDubClient.js` | `processWithAutoDub`, `ensureVoiceCloneBackend` | Manages both auto_dub_web and voicebox processes |
| `dependencyInstaller.js` | `installDependencies` | Parses pip stderr for progress; `PYTHONUNBUFFERED=1` required |
| `voiceClone.js` | `runVoiceClone` | Thin wrapper; delegates to `autoDubClient` |
| `store.js` | `getSettings`, `updateSettings` | Deep-merge settings; persisted per-user |

## Agent skills

### Issue tracker

本地 markdown 文件，存放在 `.scratch/<feature>/` 目录。See `docs/agents/issue-tracker.md`.

### Triage labels

使用默认标签：needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文布局。See `docs/agents/domain.md`.
