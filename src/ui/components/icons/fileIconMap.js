import IconFile from './IconFile';
import IconFileMarkdown from './IconFileMarkdown';
import IconFilePdf from './IconFilePdf';
import IconFileEpub from './IconFileEpub';

const EXT_MAP = {
  md:       IconFileMarkdown,
  markdown: IconFileMarkdown,
  pdf:      IconFilePdf,
  epub:     IconFileEpub,
};

export default function getFileIcon(filename) {
  const dot = filename.lastIndexOf('.');
  const ext = dot !== -1 ? filename.slice(dot + 1).toLowerCase() : '';
  return EXT_MAP[ext] ?? IconFile;
}
