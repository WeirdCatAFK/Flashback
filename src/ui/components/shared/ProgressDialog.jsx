import { createPortal } from 'react-dom';
import './ProgressDialog.css';

export default function ProgressDialog({ title, filename, progress, processing, statusText }) {
  return createPortal(
    <div className="pd-overlay">
      <div className="pd-dialog">
        <div className="pd-title">{title}</div>
        {filename && <div className="pd-filename">{filename}</div>}
        <div className="pd-track">
          <div
            className={`pd-bar${processing ? ' processing' : ''}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        {statusText && <div className="pd-status">{statusText}</div>}
      </div>
    </div>,
    document.body
  );
}
