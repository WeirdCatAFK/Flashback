/**
 * DocumentHead — what sits above every document, scrolling away with it: the cover
 * across the full width (or "Add cover"), then, on the reading measure, the folder
 * path, the title and the tags. Inherited tags are dashed and come from the folders
 * above; the document's own tags can be removed, and "+ tag" adds one in place. The
 * title is the file's name, or a clip's or video's own title (`title`) when it has one. A
 * change saves at once — there is no Save for a tag. The measure element carries
 * `data-measure`, which is what the hidden file tree measures its slide-out zone
 * against.
 */

import { useEffect, useState } from 'react';
import CoverBanner from '../cover/CoverBanner';
import { getEntityTags, getTags, documentCoverUrl, uploadDocumentCover, setDocumentCover, removeDocumentCover } from '../../api/documents';
import { docStem } from './explorer/rowFacts.js';
import { useT } from '../../translations/index';
import './DocumentHead.css';

/** "+ tag", turned into a field while a tag is typed; Enter or blur adds it. */
function TagAdder({ known, onAdd }) {
  const { t } = useT();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const finish = (save) => {
    const name = value.trim().replace(/^#/, '');
    setAdding(false);
    setValue('');
    if (save && name) onAdd(name);
  };
  if (!adding) {
    return <button type="button" className="doc-head__tag-add" onClick={() => setAdding(true)}>{t('+ tag')}</button>;
  }
  return (
    <>
      <input
        className="doc-head__tag-input"
        autoFocus
        list="doc-head-known-tags"
        placeholder={t('tag name')}
        aria-label={t('New tag')}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
        }}
        onBlur={() => finish(true)}
      />
      <datalist id="doc-head-known-tags">
        {known.map((tag) => <option key={tag} value={tag} />)}
      </datalist>
    </>
  );
}

export default function DocumentHead({ path, cover, title = null, tags = [], excludedTags = [], mayAnnotate = false, onTagsChange, onCoverChange }) {
  const { t } = useT();
  const [inherited, setInherited] = useState([]);
  const [known, setKnown] = useState([]);
  const [error, setError] = useState(null);
  const tagsKey = tags.join('\u0000');

  useEffect(() => {
    let alive = true;
    getEntityTags(path, false)
      .then((entity) => { if (alive) setInherited(entity.inherited ?? []); })
      .catch(() => { if (alive) setInherited([]); });
    return () => { alive = false; };
  }, [path, tagsKey]);

  useEffect(() => {
    if (!mayAnnotate) return undefined;
    let alive = true;
    getTags().then(({ tags: all }) => { if (alive) setKnown(all ?? []); }).catch(() => {});
    return () => { alive = false; };
  }, [mayAnnotate]);

  const save = async (next) => {
    setError(null);
    try {
      await onTagsChange(next, excludedTags);
    } catch {
      setError(t('The tags could not be saved. Try again.'));
    }
  };

  const parts = path.replace(/\\/g, '/').split('/');
  const folder = parts.slice(0, -1);
  const shownInherited = inherited.filter((tag) => !tags.includes(tag) && !excludedTags.includes(tag));
  const source = {
    imageUrl: (file) => documentCoverUrl(path, file),
    upload: (file) => uploadDocumentCover(path, file),
    set: (change) => setDocumentCover(path, change),
    remove: () => removeDocumentCover(path),
  };

  return (
    <>
      {cover && (
        <CoverBanner cover={cover} tint="var(--color-accent)" source={source} editable={mayAnnotate} onChange={onCoverChange} />
      )}
      <header className="doc-head" data-measure>
        {!cover && mayAnnotate && (
          <CoverBanner
            cover={null}
            tint="var(--color-accent)"
            source={source}
            editable
            addClassName="doc-head__add-cover"
            onChange={onCoverChange}
          />
        )}
        {folder.length > 0 && <div className="doc-head__path">{folder.join(' / ')}</div>}
        <h1 className="doc-head__title">{title || docStem(parts.at(-1))}</h1>
        <div className="doc-head__meta">
          {shownInherited.map((tag) => (
            <span key={`i:${tag}`} className="doc-head__tag doc-head__tag--inherited" title={t('From a folder above this document')}>#{tag}</span>
          ))}
          {tags.map((tag) => (
            <span key={tag} className="doc-head__tag">
              #{tag}
              {mayAnnotate && (
                <button type="button" aria-label={t('Remove tag {tag}', { tag })} onClick={() => save(tags.filter((x) => x !== tag))}>×</button>
              )}
            </span>
          ))}
          {mayAnnotate && (
            <TagAdder known={known} onAdd={(name) => { if (!tags.includes(name)) save([...tags, name]); }} />
          )}
          {error && <span className="doc-head__error" role="alert">{error}</span>}
        </div>
      </header>
    </>
  );
}
