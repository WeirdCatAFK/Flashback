// This file should be run on an electron's main process after the on event has been called
import { utilityProcess, app } from "electron";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * Spawns a new process to run the api.
 * This is done so the react frontend and the api can run independently.
 * The api is spawned after the electron main process has finished its initialization.
 * The api is given the path to the user data directory as an environment variable.
 * The api is responsible for handling all the file operations and database operations.
 * The react frontend is responsible for rendering the UI and handling user interactions.
 * When the api process is spawned, a message is logged to the console.
 * When the api process exits, a message is logged to the console.
 */
export default async function spawn() {
    // To pass static data to the child process we use env variables
    process.env.USER_DATA_PATH = app.getPath("userData");
    utilityProcess
        .fork(path.join(__dirname, "../api/main.js"))
        .on("spawn", () => console.log("API process spawned"))
        .on("exit", () => console.log("API process exited"));
}