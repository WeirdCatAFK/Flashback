import fs from "fs";
import path from "path";

/** Electron's fs.rmSync refuses a read-only file on Windows, and git writes its objects read-only. unlinkSync deletes it. */
export function removeTree(target) {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isDirectory()) return fs.unlinkSync(target);
    for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
    fs.rmdirSync(target);
}
