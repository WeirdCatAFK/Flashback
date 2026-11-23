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
