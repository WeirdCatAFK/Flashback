import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export { getDocument };

const REGION_SCALE = 2.5;
const REGION_MAX_PX = 4096;

export async function renderRegion(page, bbox, name) {
  const s = Math.min(REGION_SCALE, REGION_MAX_PX / Math.max(bbox.width, bbox.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bbox.width * s));
  canvas.height = Math.max(1, Math.round(bbox.height * s));
  const viewport = page.getViewport({ scale: s, offsetX: -bbox.x * s, offsetY: -bbox.y * s });
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? new File([blob], name, { type: 'image/png' }) : null;
}

export const isBoxHighlight = (h) => h?.type === 'pdf_bbox' && !!h.bbox && !h.text;
