/**
 * ActivityBar — the tab bar down the left edge. One icon per screen, in groups
 * that follow the process (make, study, look back, keep) with a thin rule between
 * them; one accent marker that slides to the open screen instead of jumping; and a
 * tooltip that names the screen, says in a line what it is for, and shows its
 * shortcut. The tooltip waits a moment the first time and then follows the pointer
 * along the bar at once, the way a menu bar behaves; it also appears on keyboard
 * focus. Items arrive already filtered and labelled — App owns which screens exist.
 *
 * Positions are read from `offsetTop`, which is in layout pixels, so the marker and
 * the tooltip need no conversion under the app zoom (see INTERFACE.md).
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { keyParts } from "../../keybindings";
import "./ActivityBar.css";

const TIP_DELAY = 450;
const TIP_WARM = 500;

/** Offset of `el` from the top of `bar`, summed up the offsetParent chain. */
function topWithin(el, bar) {
  let y = 0;
  for (let n = el; n && n !== bar; n = n.offsetParent) y += n.offsetTop;
  return y;
}

function NavButton({ item, active, onSelect, onTipShow, onTipHide }) {
  const { id, Icon, label } = item;
  return (
    <button
      type="button"
      data-tour={`nav-${id}`}
      className={`activity-btn${active ? " active" : ""}`}
      onClick={(e) => { onTipHide(); onSelect(id, e); }}
      onPointerEnter={(e) => onTipShow(item, e.currentTarget, false)}
      onPointerLeave={onTipHide}
      onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) onTipShow(item, e.currentTarget, true); }}
      onBlur={onTipHide}
      aria-label={label}
      aria-describedby={`activity-tip-${id}`}
      aria-keyshortcuts={item.shortcut ? item.shortcut.replace(/\bCtrl\b/g, "Control") : undefined}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={22} />
    </button>
  );
}

export default function ActivityBar({ items, bottomItems, activeView, onSelect, label }) {
  const barRef = useRef(null);
  const topRef = useRef(null);
  const [marker, setMarker] = useState(null);
  const placedRef = useRef(false);

  useLayoutEffect(() => {
    const btn = topRef.current?.querySelector(".activity-btn.active");
    setMarker(btn ? { top: btn.offsetTop, height: btn.offsetHeight, instant: !placedRef.current } : null);
    if (btn) placedRef.current = true;
  }, [activeView, items]);

  const [tip, setTip] = useState(null);
  const timerRef = useRef(0);
  const warmRef = useRef(false);
  const coolRef = useRef(0);
  useEffect(() => () => { clearTimeout(timerRef.current); clearTimeout(coolRef.current); }, []);

  const showTip = useCallback((item, el, immediate) => {
    clearTimeout(timerRef.current);
    clearTimeout(coolRef.current);
    const wasWarm = warmRef.current;
    const open = () => {
      warmRef.current = true;
      setTip({ item, top: topWithin(el, barRef.current) + el.offsetHeight / 2, warm: wasWarm });
    };
    if (immediate || wasWarm) open();
    else timerRef.current = setTimeout(open, TIP_DELAY);
  }, []);

  const hideTip = useCallback(() => {
    clearTimeout(timerRef.current);
    setTip(null);
    clearTimeout(coolRef.current);
    coolRef.current = setTimeout(() => { warmRef.current = false; }, TIP_WARM);
  }, []);

  const renderItems = (list) => list.map((item, k) => (
    <Fragment key={item.id}>
      {k > 0 && item.group !== list[k - 1].group && <span className="activity-sep" role="separator" />}
      <NavButton item={item} active={activeView === item.id} onSelect={onSelect} onTipShow={showTip} onTipHide={hideTip} />
    </Fragment>
  ));

  return (
    <>
      <nav id="activity-bar" ref={barRef} aria-label={label}>
        <div id="activity-top" ref={topRef}>
          {marker && (
            <span
              className={`activity-marker${marker.instant ? " activity-marker--instant" : ""}`}
              style={{ transform: `translateY(${marker.top}px)`, height: marker.height }}
              aria-hidden="true"
            />
          )}
          {renderItems(items)}
        </div>
        <div id="activity-bottom">{renderItems(bottomItems)}</div>
      </nav>
      {[...items, ...bottomItems].map((item) => (
        <span key={item.id} id={`activity-tip-${item.id}`} hidden>{item.purpose}</span>
      ))}
      {tip && (
        <div className={`activity-tip${tip.warm ? " activity-tip--warm" : ""}`} role="tooltip" style={{ top: tip.top }}>
          <div className="activity-tip__head">
            <span className="activity-tip__name">{tip.item.label}</span>
            {tip.item.shortcut && (
              <span className="activity-tip__keys">
                {keyParts(tip.item.shortcut).map((p) => <kbd key={p}>{p}</kbd>)}
              </span>
            )}
          </div>
          {tip.item.purpose && <span className="activity-tip__purpose">{tip.item.purpose}</span>}
        </div>
      )}
    </>
  );
}
