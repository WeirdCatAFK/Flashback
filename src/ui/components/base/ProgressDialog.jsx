/**
 * ProgressDialog — a non-dismissible modal for an upload or import in flight:
 * the title, the file name, a bar that pulses once the server is processing,
 * and a status line.
 */

import Modal from "./Modal";
import ProgressBar from "./ProgressBar";
import "./ProgressDialog.css";

export default function ProgressDialog({
  title,
  filename,
  progress,
  processing,
  statusText,
}) {
  return (
    <Modal
      ariaLabel={title}
      onClose={() => {}}
      dismissible={false}
      size="sm"
      className="pd-dialog"
    >
      <div className="pd-title">{title}</div>
      {filename && <div className="pd-filename">{filename}</div>}
      <ProgressBar
        value={(progress ?? 0) / 100}
        thick
        className={processing ? "pd-bar--processing" : ""}
      />
      {statusText && <div className="pd-status">{statusText}</div>}
    </Modal>
  );
}
