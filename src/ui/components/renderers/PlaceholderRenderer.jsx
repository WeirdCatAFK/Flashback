import "./Renderer.css";

export default function PlaceholderRenderer({ path }) {
  const ext = path?.split(".").pop()?.toUpperCase() ?? "";
  return (
    <div className="renderer-placeholder">
      <p>.{ext} files are not supported at the moment</p>
    </div>
  );
}
