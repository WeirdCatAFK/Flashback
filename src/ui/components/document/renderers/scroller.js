export function findScroller(from) {
  let el = from;
  while (el && el !== document.body) {
    const style = window.getComputedStyle(el);
    const scrolls = /(auto|scroll)/.test(style.overflowY);
    if (scrolls && el.scrollHeight > el.clientHeight + 1) return el;
    el = el.parentElement;
  }
  return null;
}
