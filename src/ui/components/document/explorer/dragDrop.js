/**
 * The drag-and-drop vocabulary of the tree: what a dragged node writes into the
 * DataTransfer, how a drop reads it back, and whether a move is legal. A drop
 * is always a move into the target folder, never a reorder. Pure.
 */

const KEYS = {
  path: "fb-path",
  isFolder: "fb-is-folder",
  hash: "fb-global-hash",
  fileName: "fb-file-name",
};

/** Stamp a tree item onto a drag's DataTransfer. */
export function writeTransfer(dt, { path, isFolder, globalHash, name }) {
  dt.setData(KEYS.path, path);
  dt.setData(KEYS.isFolder, String(!!isFolder));
  if (globalHash) {
    dt.setData(KEYS.hash, globalHash);
    dt.setData(KEYS.fileName, name);
  }
}

/** What a drop carries: a tree item, or external files. */
export function readTransfer(dt) {
  const srcPath = dt.getData(KEYS.path);
  if (srcPath)
    return {
      srcPath,
      isFolder: dt.getData(KEYS.isFolder) === "true",
      files: [],
    };
  return { srcPath: null, isFolder: false, files: Array.from(dt.files ?? []) };
}

const slash = (p) => p.replace(/\\/g, "/");

/** The last segment of a path. */
export const baseName = (p) => slash(p).split("/").pop();

/** Where `srcPath` lands when dropped into `destFolder` ('' for the root). */
export const destPathFor = (srcPath, destFolder) =>
  destFolder ? `${destFolder}/${baseName(srcPath)}` : baseName(srcPath);

/** Whether dropping `srcPath` into `destFolder` is a real move: not onto itself, its own subtree, or its own parent. */
export function canDropInto(srcPath, destFolder) {
  if (!srcPath) return false;
  if (
    destFolder &&
    (srcPath === destFolder || destFolder.startsWith(srcPath + "/"))
  )
    return false;
  return slash(srcPath) !== slash(destPathFor(srcPath, destFolder));
}
