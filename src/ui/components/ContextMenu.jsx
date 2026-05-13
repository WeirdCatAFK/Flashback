import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ContextMenu.css';

export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef();
  const [pos, setPos] = useState({ x, y });
  const [confirmIdx, setConfirmIdx] = useState(null);

  // Flip the menu if it would overflow the viewport
  useLayoutEffect(() => {
    if (!ref.current) return;
    const { offsetWidth: w, offsetHeight: h } = ref.current;
    setPos({
      x: x + w > window.innerWidth  ? x - w : x,
      y: y + h > window.innerHeight ? y - h : y,
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const onKey  = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown',   onKey);
    };
  }, [onClose]);

  const handleItem = (item, idx) => {
    if (item.danger && confirmIdx !== idx) { setConfirmIdx(idx); return; }
    item.action();
    onClose();
  };

  return createPortal(
    <div ref={ref} className="ctx-menu" style={{ top: pos.y, left: pos.x }}>
      {items.map((item, idx) =>
        item.separator
          ? <div key={idx} className="ctx-sep" />
          : confirmIdx === idx
            ? <div key={idx} className="ctx-confirm">
                <span>Delete?</span>
                <button className="ctx-confirm-yes" onClick={() => { item.action(); onClose(); }}>Yes</button>
                <button className="ctx-confirm-no"  onClick={() => setConfirmIdx(null)}>No</button>
              </div>
            : <button
                key={idx}
                className={`ctx-item${item.danger ? ' ctx-danger' : ''}${item.muted ? ' ctx-muted' : ''}`}
                onClick={() => handleItem(item, idx)}
              >
                {item.label}
              </button>
      )}
    </div>,
    document.body
  );
}
