// This file should be run on an electron's main process after the on event has been called
import { utilityProcess, app } from "electron";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export default async function spawn() {
    // To pass static data to the child process we use env variables
    process.env.USER_DATA_PATH = app.getPath("userData");
    utilityProcess
        .fork(path.join(__dirname, "../api/main.js"))
        .on("spawn", () => console.log("API process spawned"))
        .on("exit", () => console.log("API process exited"));


}