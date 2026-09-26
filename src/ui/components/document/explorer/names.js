/**
 * Naming rules for the file tree: how a listing sorts, what a name may contain,
 * which names the data model reserves (DATAMODEL.md), how a rename keeps its
 * extension, and the small path helpers the nodes share. Pure.
 */

/** Folders first, then case-insensitive by name. */
export const sortItems = (items) =>
  items.toSorted((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

/** Strip the characters Windows forbids in a filename. */
export const sanitizeName = (s) => s.replace(/[\\/:*?"<>|]/g, "");

/** `parent/name`, or just `name` at the root. */
export const childPath = (parent, name) =>
  parent ? `${parent}/${name}` : name;

/** The name a new file or folder gets from what was typed: a file without an extension becomes Markdown. */
export const newItemName = (typed, type) => {
  const trimmed = typed.trim();
  if (!trimmed) return "";
  return type === "file"
    ? trimmed.includes(".")
      ? trimmed
      : `${trimmed}.md`
    : trimmed;
};

/** A file's new name after a rename, keeping its extension unless a new one was typed. */
export const renamedFileName = (name, typed) => {
  const trimmed = typed.trim();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const base = trimmed.replace(/\.+$/, "");
  return ext && (!trimmed.includes(".") || trimmed.endsWith("."))
    ? base + ext
    : trimmed;
};

/** The path a renamed item ends up at. */
export const renamedPath = (path, name, newName) =>
  path.slice(0, path.length - name.length) + newName;

/**
 * The reserved names: `.flashback` sidecars and the per-folder `media` directory
 * are managed automatically. Returns the error message, or null when allowed.
 */
export const reservedNameError = (name, type, t) => {
  const lower = name.trim().toLowerCase();
  if (lower === ".flashback" || lower.endsWith(".flashback"))
    return t(
      'The ".flashback" name is reserved by Flashback and can’t be used here.',
    );
  if (type === "folder" && lower === "media")
    return t(
      'The "media" folder name is reserved for flashcard assets and is managed automatically.',
    );
  return null;
};

/**
 * The context menu is assembled from role-gated groups each ending in a separator;
 * this drops the separators that no longer divide anything.
 */
export const dropDanglingSeparators = (items) => {
  const out = [];
  for (const item of items) {
    if (!item?.separator) {
      out.push(item);
      continue;
    }
    if (out.length && !out[out.length - 1].separator) out.push(item);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
};

const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtu\.be)$/i;
export const looksLikeYoutube = (url) => {
  try {
    return YOUTUBE_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
};
