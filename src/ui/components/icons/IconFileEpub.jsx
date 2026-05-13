export default function IconFileEpub({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      {/* Spine */}
      <rect x="1" y="1.5" width="2" height="13" rx="0.75"
        fill="#6BBF3E" opacity="0.75"/>
      {/* Cover */}
      <rect x="2.5" y="1.5" width="7.5" height="13" rx="0.5"
        fill="#6BBF3E" opacity="0.2" stroke="#6BBF3E" strokeWidth="0.8"/>
      {/* Page stack edges (right side) */}
      <rect x="9.6"  y="2.5" width="0.6" height="11" rx="0.2" fill="#6BBF3E" opacity="0.45"/>
      <rect x="10.4" y="3"   width="0.5" height="10" rx="0.2" fill="#6BBF3E" opacity="0.25"/>
    </svg>
  );
}
