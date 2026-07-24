// This file should be run on an electron's main process after the on event has been called
import { utilityProcess, app } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { logApiLine } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * Spawns a new process to run the api.
 * This is done so the react frontend and the api can run independently.
 * The api is spawned after the electron main process has finished its initialization.
 * The api is given the path to the user data directory as an environment variable.
 * The api is responsible for handling all the file operations and database operations.
 * The react frontend is responsible for rendering the UI and handling user interactions.
 *
 * The child is forked with piped stdio so its stdout/stderr — which would otherwise
 * be discarded in a packaged build — are captured and forwarded into the shared
 * electron-log file via logApiLine(). This is also how the API's crash handlers
 * (uncaught exceptions logged to stderr, then exit 1) end up in the log.
 */
// The live API child. Kept at module scope so the main process can terminate it
// explicitly on quit/restart. Electron does not reliably reap a utilityProcess that
// still holds a listening socket (the API's HTTP server) plus keep-alive connections
// from an external MCP client, so without this the child can be orphaned on Windows
// and Flashback "doesn't fully close" after Quit.
let apiChild = null;

export default async function spawn() {
    // To pass static data to the child process we use env variables
    process.env.USER_DATA_PATH = app.getPath("userData");
    const child = utilityProcess.fork(
        path.join(__dirname, "../api/main.js"),
        [],
        { stdio: ["ignore", "pipe", "pipe"] }
    );
    apiChild = child;
    child.stdout?.on("data", (chunk) => logApiLine("stdout", chunk));
    child.stderr?.on("data", (chunk) => logApiLine("stderr", chunk));
    child.on("spawn", () => console.log("API process spawned"));
    child.on("exit", (code) => {
        console.log(`API process exited (code ${code})`);
        if (apiChild === child) apiChild = null;
    });
    return child;
}

/**
 * Force-terminate the API utility process if one is running. Safe to call
 * multiple times and when no child exists. Called from the main process on
 * before-quit and before an explicit restart so the child never outlives the app.
 */
export function killApi() {
    if (apiChild) {
        try { apiChild.kill(); } catch { /* already gone */ }
        apiChild = null;
    }
}
