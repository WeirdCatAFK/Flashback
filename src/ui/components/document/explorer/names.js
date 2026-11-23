export const sortItems = (items) =>
  items.toSorted((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

export const sanitizeName = (s) => s.replace(/[\\/:*?"<>|]/g, "");

export const childPath = (parent, name) =>
  parent ? `${parent}/${name}` : name;

export const newItemName = (typed, type) => {
  const trimmed = typed.trim();
  if (!trimmed) return "";
  return type === "file"
    ? trimmed.includes(".")
      ? trimmed
      : `${trimmed}.md`
    : trimmed;
};

export const renamedFileName = (name, typed) => {
  const trimmed = typed.trim();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const base = trimmed.replace(/\.+$/, "");
  return ext && (!trimmed.includes(".") || trimmed.endsWith("."))
    ? base + ext
    : trimmed;
};

export const renamedPath = (path, name, newName) =>
  path.slice(0, path.length - name.length) + newName;

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
