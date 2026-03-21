from __future__ import annotations

import asyncio
import re
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

from flask import Flask, render_template, request, send_from_directory, url_for
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
WORKSPACE_DIR = BASE_DIR / "workspace"
OUTPUT_DIR = BASE_DIR / "outputs"

WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_VIDEO_EXTENSIONS = {
    ".mp4",
    ".mov",
    ".mkv",
    ".avi",
    ".webm",
    ".m4v",
}

VOICE_OPTIONS = {
    "zh-CN-XiaoxiaoNeural": "中文女声（晓晓）",
    "zh-CN-YunxiNeural": "中文男声（云希）",
    "zh-CN-XiaoyiNeural": "中文女声（晓伊）",
    "en-US-JennyNeural": "English Female (Jenny)",
    "en-US-GuyNeural": "English Male (Guy)",
}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 * 1024


@dataclass
class SubtitleEntry:
    start_ms: int
    end_ms: int
    text: str


TIMESTAMP_RE = re.compile(r"^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$")


def run_command(cmd: list[str]) -> None:
    process = subprocess.run(cmd, capture_output=True, text=True)
    if process.returncode != 0:
        raise RuntimeError(
            f"命令执行失败：{' '.join(cmd)}\n\nSTDOUT:\n{process.stdout}\n\nSTDERR:\n{process.stderr}"
        )


def get_video_duration(video_path: Path) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    process = subprocess.run(cmd, capture_output=True, text=True)
    if process.returncode != 0:
        raise RuntimeError(f"无法读取视频时长：{process.stderr}")
    try:
        return float(process.stdout.strip())
    except ValueError as exc:
        raise RuntimeError("ffprobe 返回了无法解析的时长。") from exc


def timestamp_to_ms(value: str) -> int:
    match = TIMESTAMP_RE.match(value.strip())
    if not match:
        raise ValueError(f"非法时间戳：{value}")
    hour, minute, second, milli = map(int, match.groups())
    return ((hour * 60 + minute) * 60 + second) * 1000 + milli


def parse_srt_file(srt_path: Path) -> list[SubtitleEntry]:
    content = srt_path.read_text(encoding="utf-8-sig", errors="replace")
    blocks = re.split(r"\n\s*\n", content.strip())
    entries: list[SubtitleEntry] = []

    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) < 2:
            continue

        if "-->" in lines[0]:
            timeline = lines[0]
            text_lines = lines[1:]
        elif len(lines) >= 3 and "-->" in lines[1]:
            timeline = lines[1]
            text_lines = lines[2:]
        else:
            continue

        if "-->" not in timeline:
            continue

        start_raw, end_raw = [item.strip() for item in timeline.split("-->", maxsplit=1)]
        start_ms = timestamp_to_ms(start_raw)
        end_ms = timestamp_to_ms(end_raw)

        text = " ".join(text_lines).strip()
        if not text or end_ms <= start_ms:
            continue

        entries.append(SubtitleEntry(start_ms=start_ms, end_ms=end_ms, text=text))

    return entries


def ffmpeg_subtitle_path(path: Path) -> str:
    escaped = str(path.resolve()).replace("\\", "\\\\")
    escaped = escaped.replace(":", "\\:")
    escaped = escaped.replace("'", "\\'")
    return escaped


async def synthesize_tts(entries: list[SubtitleEntry], voice: str, output_dir: Path) -> list[tuple[int, Path]]:
    try:
        import edge_tts
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "缺少 `edge-tts` 依赖，请先执行 `pip install -r requirements.txt`。"
        ) from exc

    clips: list[tuple[int, Path]] = []
    for index, entry in enumerate(entries, start=1):
        clip_path = output_dir / f"line_{index:05d}.mp3"
        communicate = edge_tts.Communicate(
            text=entry.text,
            voice=voice,
            volume="+100%",
        )
        await communicate.save(str(clip_path))
        clips.append((entry.start_ms, clip_path))

    return clips


def build_voiceover_track(clips: list[tuple[int, Path]], duration_sec: float, output_audio_path: Path) -> None:
    if not clips:
        raise RuntimeError("字幕内容为空，无法生成配音。")

    cmd: list[str] = ["ffmpeg", "-y"]
    for _, clip_path in clips:
        cmd.extend(["-i", str(clip_path)])

    filter_parts: list[str] = []
    for idx, (start_ms, _) in enumerate(clips):
        filter_parts.append(
            ""
            f"[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
            f"adelay={start_ms}|{start_ms},"
            "volume=15dB"
            f"[a{idx}]"
        )

    inputs = "".join([f"[a{idx}]" for idx in range(len(clips))])
    filter_parts.append(
        f"{inputs}amix=inputs={len(clips)}:normalize=0,"
        "dynaudnorm=f=200:g=31,"
        "alimiter=limit=0.99"
        "[outa]"
    )

    cmd.extend(
        [
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            "[outa]",
            "-t",
            f"{duration_sec:.3f}",
            "-c:a",
            "pcm_s16le",
            str(output_audio_path),
        ]
    )

    run_command(cmd)


def render_output_video(
    source_video: Path,
    srt_path: Path,
    dub_audio_path: Path,
    output_video_path: Path,
) -> None:
    subtitles_arg = ffmpeg_subtitle_path(srt_path)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(source_video),
        "-i",
        str(dub_audio_path),
        "-vf",
        f"subtitles={subtitles_arg}",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "320k",
        "-movflags",
        "+faststart",
        "-shortest",
        str(output_video_path),
    ]
    run_command(cmd)


def allowed_video(filename: str) -> bool:
    ext = Path(filename).suffix.lower()
    return ext in ALLOWED_VIDEO_EXTENSIONS


@app.route("/", methods=["GET", "POST"])
def index():
    output_url = None
    error = None

    if request.method == "POST":
        video_file = request.files.get("video_file")
        srt_file = request.files.get("srt_file")
        voice = request.form.get("voice", "zh-CN-XiaoxiaoNeural")

        if not video_file or not video_file.filename:
            error = "请先上传视频文件。"
        elif not srt_file or not srt_file.filename:
            error = "请先上传 .srt 字幕文件。"
        elif not allowed_video(video_file.filename):
            error = "视频格式不支持，请使用 mp4/mov/mkv/avi/webm/m4v。"
        elif Path(srt_file.filename).suffix.lower() != ".srt":
            error = "字幕文件必须是 .srt。"
        elif voice not in VOICE_OPTIONS:
            error = "无效的配音音色。"
        else:
            job_id = uuid.uuid4().hex[:12]
            job_dir = WORKSPACE_DIR / job_id
            tts_dir = job_dir / "tts"
            job_dir.mkdir(parents=True, exist_ok=True)
            tts_dir.mkdir(parents=True, exist_ok=True)

            video_path = job_dir / f"video{Path(secure_filename(video_file.filename)).suffix.lower()}"
            srt_path = job_dir / "subtitles.srt"
            voice_wav_path = job_dir / "voiceover.wav"
            output_path = OUTPUT_DIR / f"dubbed_{job_id}.mp4"

            video_file.save(video_path)
            srt_file.save(srt_path)

            try:
                subtitle_entries = parse_srt_file(srt_path)
                if not subtitle_entries:
                    raise RuntimeError("字幕解析失败，未读取到有效字幕内容。")

                duration = get_video_duration(video_path)
                clips = asyncio.run(synthesize_tts(subtitle_entries, voice, tts_dir))
                build_voiceover_track(clips, duration, voice_wav_path)
                render_output_video(video_path, srt_path, voice_wav_path, output_path)
                output_url = url_for("get_output", filename=output_path.name)
            except Exception as exc:  # noqa: BLE001
                error = str(exc)

    return render_template(
        "index.html",
        output_url=output_url,
        error=error,
        voice_options=VOICE_OPTIONS,
    )


@app.route("/outputs/<path:filename>")
def get_output(filename: str):
    return send_from_directory(OUTPUT_DIR, filename)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)
