/**
 * subtitleParser.js — shared, robust SRT parsing/serialization.
 *
 * Extracted from smartEditor.js so both the AI "prepare" phase and the
 * compose phase (videoComposer.js) parse subtitles the same way. The parser
 * walks lines instead of relying on blank-line blocks: consecutive cues with
 * no blank line, and the common AI arrow/millisecond variants, are handled.
 */

const SRT_TIMELINE_RE = /^(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{1,3})\s*(?:-->|->|→)\s*(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/;
const SRT_TIMESTAMP_FRAGMENT_RE = /\d{1,2}:[0-5]\d:[0-5]\d[,.]\d{1,3}/;

function parseSrt(srtText) {
  const lines = String(srtText || '').replace(/\r/g, '').split('\n');
  const entries = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    let index = entries.length + 1;
    let timelineMatch = null;

    if (/^\d+$/.test(line) && i + 1 < lines.length) {
      const nextLine = lines[i + 1].trim();
      timelineMatch = nextLine.match(SRT_TIMELINE_RE);
      if (timelineMatch) {
        index = Number(line);
        i += 2;
      } else if (SRT_TIMESTAMP_FRAGMENT_RE.test(nextLine)) {
        throw new Error(`AI 返回的字幕时间线格式异常：${nextLine}`);
      }
    }

    if (!timelineMatch) {
      timelineMatch = line.match(SRT_TIMELINE_RE);
      if (timelineMatch) i += 1;
    }

    if (!timelineMatch) {
      if (SRT_TIMESTAMP_FRAGMENT_RE.test(line)) {
        throw new Error(`AI 返回的字幕时间线格式异常：${line}`);
      }
      i += 1;
      continue;
    }

    const textLines = [];
    while (i < lines.length) {
      const textLine = lines[i].trim();
      if (!textLine) {
        i += 1;
        if (textLines.length) break;
        continue;
      }
      if (textLine.match(SRT_TIMELINE_RE)) break;
      if (/^\d+$/.test(textLine) && i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (nextLine.match(SRT_TIMELINE_RE)) break;
        if (SRT_TIMESTAMP_FRAGMENT_RE.test(nextLine)) {
          throw new Error(`AI 返回的字幕时间线格式异常：${nextLine}`);
        }
      }
      if (SRT_TIMESTAMP_FRAGMENT_RE.test(textLine)) {
        throw new Error(`AI 返回的字幕时间线格式异常：${textLine}`);
      }
      textLines.push(textLine);
      i += 1;
    }

    const text = textLines.join('\n').trim();
    if (!text) continue;
    const startMs = +timelineMatch[1] * 3600000 + +timelineMatch[2] * 60000 + +timelineMatch[3] * 1000 + Number(String(timelineMatch[4]).padStart(3, '0'));
    const endMs = +timelineMatch[5] * 3600000 + +timelineMatch[6] * 60000 + +timelineMatch[7] * 1000 + Number(String(timelineMatch[8]).padStart(3, '0'));
    entries.push({ index, startMs, endMs, text });
  }
  return entries;
}

function fmtMs(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const l = Math.floor(ms % 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(l).padStart(3, '0')}`;
}

function entriesToSrt(entries) {
  return entries.map((e) => `${e.index}\n${fmtMs(e.startMs)} --> ${fmtMs(e.endMs)}\n${e.text}`).join('\n\n') + '\n';
}

module.exports = {
  SRT_TIMELINE_RE,
  SRT_TIMESTAMP_FRAGMENT_RE,
  parseSrt,
  fmtMs,
  entriesToSrt,
};