import { useState, useEffect, useCallback } from "react";
import "./Manage.css";
import {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from "../api/categories";
import { getTagUsage } from "../api/tags";
import { LoadingState, ErrorState } from "../components/shared/StateView";

/**
 * Manage — the knowledge-environment tab. Unlike a document or a card, the things
 * here (pedagogical categories, tags) are vault-wide metadata: they shape how your
 * whole knowledge base is organized and studied. Categories are fully editable;
 * tags are shown read-only (they're applied per file/folder in the Inspector) so
 * you can see what exists and how widely each is used.
 */

// ── Pedagogical categories ────────────────────────────────────────────────────

function CategoryRow({ cat, onSave, onDelete }) {
  const [name, setName] = useState(cat.name);
  const [priority, setPriority] = useState(cat.priority);
  const [description, setDescription] = useState(cat.description ?? "");

  useEffect(() => { setName(cat.name); }, [cat.name]);
  useEffect(() => { setPriority(cat.priority); }, [cat.priority]);
  useEffect(() => { setDescription(cat.description ?? ""); }, [cat.description]);

  return (
    <tr className="mng-cat-row">
      <td>
        <input
          type="number"
          className="mng-input mng-input--priority"
          value={priority}
          min={0}
          max={99}
          onChange={(e) => setPriority(e.target.value)}
          onBlur={() => onSave(cat.id, { priority: Number(priority) })}
          aria-label="Priority"
        />
      </td>
      <td>
        <input
          type="text"
          className="mng-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => onSave(cat.id, { name })}
          aria-label="Category name"
          maxLength={200}
        />
      </td>
      <td>
        <input
          type="text"
          className="mng-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => onSave(cat.id, { description })}
          aria-label="Description"
          maxLength={500}
        />
      </td>
      <td>
        <button
          type="button"
          className="mng-delete-btn"
          onClick={() => onDelete(cat.id)}
          title="Delete category"
          aria-label={`Delete ${cat.name}`}
        >
          ×
        </button>
      </td>
    </tr>
  );
}

function CategoriesPanel({ refreshKey }) {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [draft, setDraft] = useState({ name: "", priority: 0, description: "" });
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    getCategories()
      .then((c) => { setCategories(c); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload, refreshKey]);

  const handleSave = (id, data) => {
    if (data.name !== undefined && !data.name.trim()) return;
    updateCategory(id, data).then(reload);
  };

  const handleDelete = (id) => {
    setDeleteError(null);
    deleteCategory(id).then(reload).catch((err) => setDeleteError(err.message));
  };

  const handleAdd = () => {
    if (!draft.name.trim()) return;
    setAdding(true);
    createCategory({
      name: draft.name.trim(),
      priority: Number(draft.priority) || 0,
      description: draft.description,
    })
      .then(() => {
        setDraft({ name: "", priority: 0, description: "" });
        reload();
      })
      .finally(() => setAdding(false));
  };

  // Keep showing existing rows while a background refresh is in flight — only
  // surface the full-panel loading/error states when we have nothing to show yet.
  const firstLoad = loading && categories.length === 0;

  return (
    <section className="mng-section">
      <div className="mng-section-head">
        <h2 className="mng-section-label">
          Pedagogical categories
          {categories.length > 0 && <span className="mng-count">{categories.length}</span>}
        </h2>
        <p className="mng-section-hint">
          Classify each card by its learning purpose — definition, concept,
          application… Lower priority is studied first; cards with no category are
          treated as priority 0.
        </p>
      </div>

      {firstLoad ? (
        <LoadingState message="Loading categories…" />
      ) : error && categories.length === 0 ? (
        <ErrorState error={error} onRetry={reload} />
      ) : (
        <table className="mng-table">
          <thead>
            <tr>
              <th className="mng-th mng-th--priority">Priority</th>
              <th className="mng-th">Name</th>
              <th className="mng-th">Description</th>
              <th className="mng-th mng-th--action" />
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <CategoryRow key={cat.id} cat={cat} onSave={handleSave} onDelete={handleDelete} />
            ))}
            <tr className="mng-cat-row mng-add-row">
              <td>
                <input
                  type="number"
                  className="mng-input mng-input--priority"
                  value={draft.priority}
                  min={0}
                  max={99}
                  onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
                  aria-label="New category priority"
                />
              </td>
              <td>
                <input
                  type="text"
                  className="mng-input"
                  placeholder="New category…"
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                  aria-label="New category name"
                  maxLength={200}
                />
              </td>
              <td>
                <input
                  type="text"
                  className="mng-input"
                  placeholder="Description…"
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                  aria-label="New category description"
                  maxLength={500}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="mng-add-btn"
                  onClick={handleAdd}
                  disabled={!draft.name.trim() || adding}
                >
                  Add
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {deleteError && <p className="mng-error">{deleteError}</p>}
    </section>
  );
}

// ── Tags ──────────────────────────────────────────────────────────────────────

function TagsPanel({ refreshKey }) {
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("");

  const reload = useCallback(() => {
    setLoading(true);
    getTagUsage()
      .then((t) => { setTags(t); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload, refreshKey]);

  const q = filter.trim().toLowerCase();
  const shown = q ? tags.filter((t) => t.name.toLowerCase().includes(q)) : tags;

  const firstLoad = loading && tags.length === 0;

  return (
    <section className="mng-section">
      <div className="mng-section-head">
        <h2 className="mng-section-label">
          Tags
          {tags.length > 0 && <span className="mng-count">{tags.length}</span>}
        </h2>
        <p className="mng-section-hint">
          Every tag in your vault and how many items apply it directly. Tags are
          added or removed on a file or folder from the Inspector, and inherit down
          the folder tree.
        </p>
      </div>

      {firstLoad ? (
        <LoadingState message="Loading tags…" />
      ) : error && tags.length === 0 ? (
        <ErrorState error={error} onRetry={reload} />
      ) : tags.length === 0 ? (
        <p className="mng-empty">
          No tags yet. Add tags to a file or folder from the Inspector and they
          will appear here.
        </p>
      ) : (
        <>
          <input
            type="search"
            className="mng-input mng-tag-filter"
            placeholder="Filter tags…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter tags"
          />
          {shown.length === 0 ? (
            <p className="mng-empty">No tags match “{filter}”.</p>
          ) : (
            <ul className="mng-tag-list">
              {shown.map((t) => (
                <li
                  key={t.name}
                  className="mng-tag-chip"
                  title={`${t.count} item${t.count === 1 ? "" : "s"}`}
                >
                  <span className="mng-tag-name">{t.name}</span>
                  <span className="mng-tag-count">{t.count}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// ── View ────────────────────────────────────────────────────────────────────

export default function Manage({ isActive }) {
  // Metadata can change from other tabs (tagging a file, importing a deck), so
  // re-pull whenever this tab regains focus rather than caching once on mount.
  // Views stay mounted after first visit, so this effect is what makes Manage
  // refresh on every open.
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (isActive) setRefreshKey((k) => k + 1);
  }, [isActive]);

  return (
    <div className="mng-view">
      <div className="mng-body">
        <header className="mng-header">
          <h1 className="mng-title">Management</h1>
          <p className="mng-lede">
            Vault-wide metadata that shapes how your whole knowledge base is
            classified and studied.
          </p>
        </header>
        <CategoriesPanel refreshKey={refreshKey} />
        <TagsPanel refreshKey={refreshKey} />
      </div>
    </div>
  );
}
