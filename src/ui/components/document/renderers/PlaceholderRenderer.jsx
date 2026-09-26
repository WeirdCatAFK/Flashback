/**
 * PlaceholderRenderer — what a format the app cannot render yet shows.
 */

import { useT } from "../../../translations/index";
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
