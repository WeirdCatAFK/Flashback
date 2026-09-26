/**
 * The transcript as a document, as plain functions: captions grouped into paragraphs,
 * each highlight placed on the words it covers, a paragraph cut into plain and marked
 * runs, and which paragraph or line a moment in the video falls in. No React, no DOM.
 *
 * A highlight on a video is a `video_timestamp` entry: a `start` in seconds and a
 * `text`. It is placed in the paragraph its `start` falls in, on the first occurrence
 * of its text from the line it starts on. One with no text of its own (a moment marked
 * from the player before captions existed, stored as "@ m:ss") covers the whole line
 * at its time. One whose text is not in the captions at all is a note someone wrote;
 * it is returned as `loose` and shown as a note between the paragraphs.
 */

/** A paragraph closes after a sentence once it spans this many seconds, and regardless at the next. */
const SOFT_SPAN = 25;
const HARD_SPAN = 45;

/** Whether a highlight's text is only the time a moment was marked at, not words of its own. */
export const isBlankNote = (text) => !text || /^@ \d/.test(String(text).trim());

/**
 * Captions (`{ start, dur, text }`) as paragraphs: `{ start, text, cues }`, where each
 * cue carries its `offset` into the paragraph's text.
 */
export function groupCues(cues) {
  const paras = [];
  let cur = null;
  for (const raw of cues ?? []) {
    const line = String(raw?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const start = Number(raw.start) || 0;
    const span = cur ? start - cur.start : 0;
    const sentenceEnded = cur && /[.?!…]["”’)]?$/.test(cur.text);
    if (!cur || span >= HARD_SPAN || (span >= SOFT_SPAN && sentenceEnded)) {
      cur = { start, text: '', cues: [] };
      paras.push(cur);
    }
    const offset = cur.text ? cur.text.length + 1 : 0;
    cur.text = cur.text ? `${cur.text} ${line}` : line;
    cur.cues.push({ start, offset, length: line.length });
  }
  return paras;
}

/** The index of the paragraph a time falls in (the last to start at or before it), or -1 before the first. */
export function paraIndexAt(paras, seconds) {
  let found = -1;
  for (let i = 0; i < paras.length; i++) {
    if (paras[i].start <= seconds) found = i; else break;
  }
  return found;
}

/** The line of a paragraph a time falls in. */
export function cueAt(para, seconds) {
  let found = para.cues[0];
  for (const c of para.cues) { if (c.start <= seconds) found = c; else break; }
  return found;
}

/** The time of the line a character offset in a paragraph falls in. */
export function timeAtOffset(para, offset) {
  let found = para.cues[0];
  for (const c of para.cues) { if (c.offset <= offset) found = c; else break; }
  return found?.start ?? para.start;
}

/**
 * Where every highlight goes: `ranges` per paragraph index (`{ id, color, from, to }`)
 * and the `loose` ones — notes whose words are not in the captions.
 */
export function placeHighlights(paras, highlights) {
  const ranges = new Map();
  const loose = [];
  for (const h of highlights ?? []) {
    const i = paraIndexAt(paras, Number(h.start) || 0);
    if (i < 0) { loose.push(h); continue; }
    const para = paras[i];
    const cue = cueAt(para, Number(h.start) || 0);
    let from = -1, to = -1;
    if (isBlankNote(h.text)) {
      from = cue.offset; to = cue.offset + cue.length;
    } else {
      const text = String(h.text).trim();
      from = para.text.indexOf(text, cue.offset);
      if (from < 0) from = para.text.indexOf(text);
      if (from >= 0) to = from + text.length;
    }
    if (from < 0) { loose.push(h); continue; }
    if (!ranges.has(i)) ranges.set(i, []);
    ranges.get(i).push({ id: h.id, color: h.color ?? 'amber', from, to });
  }
  return { ranges, loose };
}

/** A paragraph's text as runs, plain or marked by one highlight; overlapping marks yield to the earlier. */
export function segments(text, ranges = []) {
  const out = [];
  let at = 0;
  for (const r of [...ranges].sort((a, b) => a.from - b.from || b.to - a.to)) {
    if (r.from < at || r.to <= r.from) continue;
    if (r.from > at) out.push({ text: text.slice(at, r.from) });
    out.push({ text: text.slice(r.from, r.to), id: r.id, color: r.color });
    at = r.to;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** The highlight in a paragraph's ranges that overlaps [from, to), if any. */
export function rangeOverlapping(ranges, from, to) {
  return (ranges ?? []).find((r) => r.from < to && r.to > from) ?? null;
}
