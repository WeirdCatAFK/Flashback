/**
 * CoverArt — the drawn covers, the ones a deck or a document can wear without anyone
 * finding a picture. Each is pure geometry in a 620×150 box, cropped to fill whatever
 * holds it (`slice`): a wide banner shows about the middle band (y 40–110), a menu
 * thumbnail the middle stretch (x 85–535), so every drawing keeps its interest there.
 *
 * Nothing carries a colour of its own; CoverArt.css paints by class. A group marked
 * `cover-art__fill` fills its pieces and `cover-art__line` strokes them in the owner's
 * colour (--sleeve), `cover-art__rule` strokes and `cover-art__ground` fills in the
 * banner's own ground (--cover-ground) to cut shapes back out; a piece marked `is-full`, `is-mid`,
 * `is-light` or `is-ground` takes that step between the two, and `is-sheet` outlines it
 * in the ground so overlapping sheets read apart. The scatter comes from a fixed hash,
 * so a cover looks the same every time it is drawn (artKit.js). The drawings are built
 * once, at load, one module per menu section (studyArt, mathArt, scienceArt, natureArt,
 * humanitiesArt, patternArt; space has three, spaceWorksArt, spaceIsoArt and spaceSkyArt,
 * over spaceKit and spaceParts). The ids are in shared/covers.js, since the API checks them;
 * their names and the menu's order are in coverPatterns.js.
 */

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

/**
 * A drawn cover, filling its box; an unknown id draws the scattered cards. `still` keeps
 * it from moving whatever the preference says (the menu's thumbnails).
 */
export default function CoverArt({ pattern, still = false }) {
  return (
    <svg className={`cover-art${still ? ' is-still' : ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {ART[pattern] ?? STUDY_ART.cards}
    </svg>
  );
}
