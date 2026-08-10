import { useT } from "../../../translations";
import "./Renderer.css";

export default function PlaceholderRenderer({ path }) {
  const { t } = useT();
  const ext = path?.split(".").pop()?.toUpperCase() ?? "";
  return (
    <div className="renderer-placeholder">
      <p>{t('.{ext} files are not supported at the moment', { ext })}</p>
    </div>
  );
}
