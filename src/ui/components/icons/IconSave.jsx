export default function IconSave({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M2.5 1.5h8L14 5v9a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 2 14V2a.5.5 0 0 1 .5-.5z"
        fill="currentColor" opacity="0.12" stroke="currentColor" strokeWidth="1"/>
      <path d="M4.5 1.5v4h5v-4" stroke="currentColor" strokeWidth="1" fill="none"/>
      <rect x="4.5" y="8.5" width="7" height="6" rx="0.5"
        stroke="currentColor" strokeWidth="1" fill="none"/>
    </svg>
  );
}
