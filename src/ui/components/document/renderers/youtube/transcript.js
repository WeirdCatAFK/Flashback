const SOFT_SPAN = 25;
const HARD_SPAN = 45;

export const isBlankNote = (text) => !text || /^@ \d/.test(String(text).trim());

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

export function paraIndexAt(paras, seconds) {
  let found = -1;
  for (let i = 0; i < paras.length; i++) {
    if (paras[i].start <= seconds) found = i; else break;
  }
  return found;
}

export function cueAt(para, seconds) {
  let found = para.cues[0];
  for (const c of para.cues) { if (c.start <= seconds) found = c; else break; }
  return found;
}

export function timeAtOffset(para, offset) {
  let found = para.cues[0];
  for (const c of para.cues) { if (c.offset <= offset) found = c; else break; }
  return found?.start ?? para.start;
}

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

export function rangeOverlapping(ranges, from, to) {
  return (ranges ?? []).find((r) => r.from < to && r.to > from) ?? null;
}
