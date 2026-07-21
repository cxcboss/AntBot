# Clip Cache Cleanup Design

Date: 2026-07-21
Branch: `codex/fix-repeated-video-voice`

## Goal

Consolidate the latest smart-edit implementation and the repeated-voice fix into one branch, then make clip artifacts explicitly owned and reliably cleaned without touching dependencies, settings, models, browser profiles, voice profiles, or final videos.

## Source Baseline

The current branch contains the repeated Voicebox speech fix. The latest smart-edit implementation is present as uncommitted work in the `claude/nifty-cray-f84ebe` worktree. The implementation will bring the smart-edit source changes needed by the currently used app into the current branch while preserving the current branch's Voicebox fixes.

Unrelated user changes and generated artifacts will not be reverted or included merely because they exist in either worktree.

## Protected Data

Cleanup must never delete these locations or their contents:

- `~/AntBot/models/`
- `~/AntBot/voicebox-data/models/`
- `~/AntBot/voicebox-data/profiles/`
- `~/AntBot/voicebox-env/`
- `~/AntBot/browser-profiles/`
- App settings, voice profile metadata, usage data, style references, and logs
- Completed output videos selected by the user
- Cache belonging to a live task that can still resume safely

## Owned Clip Artifacts

New smart-edit work uses a dedicated root at `~/AntBot/clip-cache/`. Each task gets one directory whose name is derived from its task ID. That directory may contain:

- Extracted frame images
- Generated subtitles
- Uploaded or copied source video data
- Per-line TTS audio
- Mixed voice tracks
- Incomplete composed video files
- A small task manifest used for startup recovery

Legacy artifacts are recognized only through narrow application-owned patterns:

- `antbot-smart-edit-*` directories under the operating-system temporary directory
- `workspace/` and `outputs/` under the bundled `auto_dub_web` project
- Voicebox generation records confirmed to have been created by the old clip pipeline

No broad deletion of `~/AntBot`, the system temporary directory, or a user-configured output directory is allowed.

## Voice Generation

Clip TTS will use Voicebox's `/generate/stream` endpoint. This endpoint returns WAV data directly and does not create a Voicebox history row or a file in `voicebox-data/generations`.

The existing request payload keeps `x_vector_only_mode: true` so the reference sample cannot leak into generated speech. Model readiness remains handled before clip generation starts. Standalone Voicebox generations outside the clip workflow keep their existing persistent history behavior.

## Runtime Cleanup

Cleanup is idempotent and best-effort. A cleanup failure is logged but does not overwrite the original task error.

Task behavior:

- Preparation failure or cancellation deletes frames, subtitles, and the task cache directory.
- Composition failure, cancellation, or interruption deletes generated audio, copied media, incomplete output, and the task cache directory.
- Successful completion keeps only the final output video and history metadata.
- Paused or `ready` tasks retain only the minimum resumable state. Frames are deleted as soon as subtitle preparation succeeds.
- Removing a task performs the same terminal cleanup.

`auto_dub_web` behavior:

- A job workspace is removed in `finally`, on both success and failure.
- Its temporary output copy is removed after the Electron client copies the final video.
- Server startup removes stale workspaces and output copies left by a crash.

## Startup Recovery

Before scheduling edit work, startup loads `edit-tasks.json` and reconciles persisted tasks with the cache filesystem:

- `failed`, `cancelled`, and `completed` tasks have residual cache removed.
- Interrupted `preparing` and `composing` tasks have incomplete cache removed and return to `pending`.
- A `ready` task is retained only when its subtitle and required metadata still exist; otherwise its cache is removed and it returns to `pending`.
- Orphan task directories not referenced by a resumable task are removed.
- Legacy `antbot-smart-edit-*` directories are removed when no current task owns them.
- Stale `auto_dub_web/workspace` and `auto_dub_web/outputs` entries are removed before the server accepts work.

## Existing Data Cleanup

The current Voicebox database contains 261 generation rows, about 145 MB of WAV data, created between 2026-07-18 and 2026-07-20. Their text and timestamps match clip jobs, and none is referenced by a Voicebox story. They can be removed through the Voicebox history API so database rows and audio files stay consistent.

The cleanup will also remove the zero-byte abandoned `antbot-store.json.*.tmp` file and application-owned legacy clip directories found during the final pre-clean scan. Models, environments, settings, profiles, and browser data remain untouched.

## Testing

Automated tests will cover:

- Protected paths cannot be classified as clip artifacts.
- Terminal task states delete their owned cache.
- Resumable `ready` tasks retain valid subtitles.
- Interrupted tasks are reset and cleaned during startup.
- Orphan and legacy cache directories are removed without touching unrelated temporary files.
- Voicebox clip requests use streaming generation and preserve `x_vector_only_mode`.
- `auto_dub_web` removes job workspaces and output copies on success and failure.

Verification includes focused Node tests, Python backend tests, syntax checks, a real data-directory audit before and after cleanup, and a macOS package build.

## Delivery

The development log will record the root cause, protected data boundaries, deleted artifact counts and sizes, implementation details, tests, and package output. The built `.app` and normal macOS build artifacts will be placed under `/Users/chenxincheng/Desktop/my/Develop/Claude/AntBot`.
