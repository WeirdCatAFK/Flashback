/**
 * QuietRow — a list row that shows only what identifies the item until you reach
 * it: its secondary actions appear on hover or keyboard focus (and stay visible
 * where there is no hover). A row with `onOpen` opens on click or Enter, the way a
 * tag row opens its cards; the actions never trigger it.
 *
 *   <QuietRow onOpen={showCards} actions={<><button className="link-action">Rename</button></>}>
 *     <span className="quiet-row__name">#memory</span>
 *   </QuietRow>
 */

export default function QuietRow({ children, actions, onOpen, muted = false, className = "", label }) {
  const open = onOpen
    ? {
        role: "button",
        tabIndex: 0,
        "aria-label": label,
        onClick: (e) => { if (!e.target.closest(".quiet-row__actions")) onOpen(); },
        onKeyDown: (e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(); }
        },
      }
    : {};
  return (
    <div className={`quiet-row${onOpen ? " quiet-row--open" : ""}${muted ? " quiet-row--muted" : ""}${className ? ` ${className}` : ""}`} {...open}>
      {children}
      {actions && <div className="quiet-row__actions">{actions}</div>}
    </div>
  );
}
