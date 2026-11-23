const KEYS = {
  path: "fb-path",
  isFolder: "fb-is-folder",
  hash: "fb-global-hash",
  fileName: "fb-file-name",
};

export function writeTransfer(dt, { path, isFolder, globalHash, name }) {
  dt.setData(KEYS.path, path);
  dt.setData(KEYS.isFolder, String(!!isFolder));
  if (globalHash) {
    dt.setData(KEYS.hash, globalHash);
    dt.setData(KEYS.fileName, name);
  }
}

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

export const baseName = (p) => slash(p).split("/").pop();

export const destPathFor = (srcPath, destFolder) =>
  destFolder ? `${destFolder}/${baseName(srcPath)}` : baseName(srcPath);

export function canDropInto(srcPath, destFolder) {
  if (!srcPath) return false;
  if (
    destFolder &&
    (srcPath === destFolder || destFolder.startsWith(srcPath + "/"))
  )
    return false;
  return slash(srcPath) !== slash(destPathFor(srcPath, destFolder));
}
