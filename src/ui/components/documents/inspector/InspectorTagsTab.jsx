import { useState, useEffect, useCallback } from 'react';
import { getTags, getEntityTags } from '../../../api/documents';
import TagChipInput from '../../shared/TagChipInput';
import { useT } from '../../../translations';
import { useSession } from '../../../sessionContext.js';

export default function InspectorTagsTab({ path, tags: propTags = [], onTagsChange }) {
  const { t } = useT();
  // Tagging writes the sidecar, so it is an annotation. The tags themselves stay readable
  // without the role — they are how a document is filed, and a Reader needs to see that.
  const { can } = useSession();
  const mayEdit = can('annotate');
  const [directTags, setDirectTags]     = useState(propTags);
  const [inheritedTags, setInheritedTags] = useState([]);
  const [allKnownTags, setAllKnownTags] = useState([]);
  const [dirty, setDirty]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  // Sync direct tags when parent refreshes the sidecar (e.g. after save)
  useEffect(() => {
    setDirectTags(propTags);
    setDirty(false);
  }, [JSON.stringify(propTags), path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch inherited tags + all known tags whenever the active file changes
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    Promise.all([getEntityTags(path, false), getTags()])
      .then(([entity, { tags: all }]) => {
        if (cancelled) return;
        setInheritedTags(entity.inherited ?? []);
        setAllKnownTags(all ?? []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path]);

  const addTag = useCallback((name) => {
    setDirectTags(prev => prev.includes(name) ? prev : [...prev, name]);
    setDirty(true);
    setError(null);
  }, []);

  const removeTag = useCallback((name) => {
    setDirectTags(prev => prev.filter(tag => tag !== name));
    setDirty(true);
    setError(null);
  }, []);

  const handleSave = async () => {
    if (!onTagsChange) return;
    setSaving(true);
    setError(null);
    try {
      await onTagsChange(directTags, []);
      setDirty(false);
      // Re-fetch inherited after propagation may have updated them
      const entity = await getEntityTags(path, false);
      setInheritedTags(entity.inherited ?? []);
    } catch (err) {
      setError(t('Save failed. Please try again.'));
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setDirectTags(propTags);
    setDirty(false);
    setError(null);
  };

  if (!path) return <div className="inspector-placeholder"><p>{t('No file open.')}</p></div>;

  return (
    <div className="tags-tab">
      {inheritedTags.length > 0 && (
        <div className="tags-section">
          <div className="tags-section-label">
            {t('Inherited')}
            <span className="tags-section-hint">{t('from parent folders')}</span>
          </div>
          <div className="tags-chip-row">
            {inheritedTags.map(tag => (
              <span key={tag} className="tag-chip tag-chip--inherited">{tag}</span>
            ))}
          </div>
        </div>
      )}

      <div className="tags-section">
        <div className="tags-section-label">{t('Direct tags')}</div>
        {mayEdit ? (
          <TagChipInput
            tags={directTags}
            onAdd={addTag}
            onRemove={removeTag}
            allKnownTags={allKnownTags}
            placeholder={t('Add tag…')}
            chipClass="tag-chip--direct"
          />
        ) : (
          <div className="tags-chip-row">
            {directTags.map(tag => (
              <span key={tag} className="tag-chip tag-chip--direct">{tag}</span>
            ))}
          </div>
        )}
      </div>

      {error && <p className="tags-error">{error}</p>}

      {dirty && (
        <div className="tags-actions">
          <button type="button" className="tags-btn tags-btn--ghost" onClick={handleDiscard}>{t('Discard')}</button>
          <button type="button" className="tags-btn tags-btn--save" onClick={handleSave} disabled={saving}>
            {saving ? t('Saving…') : t('Save')}
          </button>
        </div>
      )}

      {!dirty && directTags.length === 0 && inheritedTags.length === 0 && (
        <p className="inspector-placeholder" style={{ marginTop: 12 }}>
          {mayEdit
            ? t('No tags yet. Add a direct tag above, or assign tags to a parent folder.')
            : t('No tags on this document.')}
        </p>
      )}
    </div>
  );
}
