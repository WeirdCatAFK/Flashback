/**
 * The tree's context menu as data: role-gated groups for a file, a folder or
 * the root, each ending in a separator, then trimmed. Labels arrive translated.
 */

import { dropDanglingSeparators } from "./names.js";

/**
 * @param {object} ctx  what was right-clicked: `{ isRoot, isFolder, filePath, folderPath, folderColor, … }`
 * @param {object} h    handlers `{ study, editTags, setColor, importTo, newFile, newFolder, clip, rename, remove }`
 */
export function contextMenuItems(ctx, can, t, h) {
  const file = !ctx.isFolder && !ctx.isRoot && ctx.filePath;
  return dropDanglingSeparators([
    ...(file
      ? [
          {
            label: t("Study document"),
            action: () => h.study({ document: ctx.filePath }),
          },
          {
            label: t("Leave out of study"),
            action: () => h.study({ exclude: { documents: [ctx.filePath] } }),
          },
          { separator: true },
        ]
      : []),
    ...(ctx.isFolder
      ? [
          {
            label: t("Study folder"),
            action: () => h.study({ folder: ctx.folderPath }),
          },
          {
            label: t("Leave out of study"),
            action: () => h.study({ exclude: { folders: [ctx.folderPath] } }),
          },
          ...(can("annotate")
            ? [
                {
                  label: t("Edit tags"),
                  action: () => h.editTags(ctx.folderPath),
                },
                { label: t("Set color"), action: () => h.setColor(ctx) },
              ]
            : []),
          ...(can("importDocuments")
            ? [
                {
                  label: t("Import to folder"),
                  action: () => h.importTo(ctx.folderPath),
                },
              ]
            : []),
          { separator: true },
        ]
      : []),
    ...((ctx.isFolder || ctx.isRoot) && can("createDocuments")
      ? [
          { label: t("New File"), action: ctx.doNewFile },
          { label: t("New Folder"), action: ctx.doNewFolder },
          { label: t("Clip from URL"), action: () => h.clip(ctx) },
          ...(ctx.isRoot && can("importDocuments")
            ? [
                {
                  label: t("Import files/packages"),
                  action: () => h.importTo(""),
                },
              ]
            : []),
          { separator: true },
        ]
      : []),
    ...(ctx.isRoot || !can("changeVaultShape")
      ? []
      : [
          { label: t("Rename"), action: ctx.triggerRename },
          { label: t("Delete"), action: ctx.doDelete, danger: true },
        ]),
  ]);
}
