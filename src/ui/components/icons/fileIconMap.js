/**
 * Which file icon a document gets, by extension.
 */

import IconFile      from './IconFile';
import IconFileMarkdown from './IconFileMarkdown';
import IconFilePdf    from './IconFilePdf';
import IconFileEpub   from './IconFileEpub';
import IconFileTxt    from './IconFileTxt';
import IconFileHtml   from './IconFileHtml';
import IconFileImage  from './IconFileImage';
import IconFileAudio  from './IconFileAudio';
import IconFileVideo  from './IconFileVideo';

const EXT_MAP = {
  md:       IconFileMarkdown,
  markdown: IconFileMarkdown,
  txt:      IconFileTxt,
  html:     IconFileHtml,
  htm:      IconFileHtml,

  pdf:      IconFilePdf,
  epub:     IconFileEpub,

  jpg:      IconFileImage,
  jpeg:     IconFileImage,
  png:      IconFileImage,
  webp:     IconFileImage,
  gif:      IconFileImage,
  svg:      IconFileImage,
  avif:     IconFileImage,

  mp3:      IconFileAudio,
  ogg:      IconFileAudio,
  wav:      IconFileAudio,
  flac:     IconFileAudio,
  m4a:      IconFileAudio,

  mp4:      IconFileVideo,
  mkv:      IconFileVideo,
  webm:     IconFileVideo,
  mov:      IconFileVideo,
  avi:      IconFileVideo,

  youtube:  IconFileVideo,
  clip:     IconFileHtml,
};

export default function getFileIcon(filename) {
  const dot = filename.lastIndexOf('.');
  const ext = dot !== -1 ? filename.slice(dot + 1).toLowerCase() : '';
  return EXT_MAP[ext] ?? IconFile;
}
