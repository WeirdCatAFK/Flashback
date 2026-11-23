const ACTION_HEIGHT = 44;
const ACTION_ABOVE = 34;
const ACTION_GAP = 6;

export function toShellRect(contents, rect) {
  const iframe = contents.document?.defaultView?.frameElement;
  const io = iframe?.getBoundingClientRect();
  if (!rect || !io) return null;
  const z = iframe.offsetWidth ? io.width / iframe.offsetWidth : 1;
  return { top: io.top / z + rect.top, left: io.left / z + rect.left, width: rect.width, height: rect.height };
}

export function imageActionPosition(rect, viewportHeight) {
  return rect.top + rect.height + ACTION_HEIGHT > viewportHeight
    ? { top: rect.top - ACTION_ABOVE, left: rect.left }
    : { top: rect.top + rect.height + ACTION_GAP, left: rect.left };
}

export function hrefFromRenderedSrc(book, src) {
  const res = book?.resources;
  if (!src || !res?.urls || !res?.replacementUrls) return null;
  if (res.urls.length !== res.replacementUrls.length) return null;
  const i = res.replacementUrls.indexOf(src);
  return i === -1 ? null : res.urls[i];
}
