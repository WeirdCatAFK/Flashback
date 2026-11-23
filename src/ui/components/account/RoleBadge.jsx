import { useT } from "../../translations/index";
import { useSession } from "../../utils/sessionContext.js";
import { roleLabel } from "../../utils/roleLabels.js";
import "./RoleBadge.css";

export default function RoleBadge({ connection }) {
  const { t } = useT();
  const { role, loading, error } = useSession();

  if (connection?.kind !== "remote") return null;

  if (loading) return null;
  if (error || !role) {
    return (
      <span
        className="role-badge role-badge--unknown"
        title={error || t("Could not read your role on this server.")}
      >
        {t("Role unknown")}
      </span>
    );
  }

  return (
    <span
      className={`role-badge role-badge--${role}`}
      title={t("Your role on this server")}
    >
      {roleLabel(t, role)}
    </span>
  );
}
