import { W, H } from './artKit.js';
import { STUDY_ART } from './studyArt.jsx';
import { MATH_ART } from './mathArt.jsx';
import { SCIENCE_ART } from './scienceArt.jsx';
import { NATURE_ART } from './natureArt.jsx';
import { HUMANITIES_ART } from './humanitiesArt.jsx';
import { SPACE_WORKS_ART } from './spaceWorksArt.jsx';
import { SPACE_SKY_ART } from './spaceSkyArt.jsx';
import { SPACE_ISO_ART } from './spaceIsoArt.jsx';
import { PATTERN_ART } from './patternArt.jsx';
import './CoverArt.css';

const ART = { ...STUDY_ART, ...MATH_ART, ...SCIENCE_ART, ...NATURE_ART, ...HUMANITIES_ART, ...SPACE_WORKS_ART, ...SPACE_ISO_ART, ...SPACE_SKY_ART, ...PATTERN_ART };

export default function CoverArt({ pattern, still = false }) {
  return (
    <svg className={`cover-art${still ? ' is-still' : ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {ART[pattern] ?? STUDY_ART.cards}
    </svg>
  );
}
