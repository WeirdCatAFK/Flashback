import { utilityProcess, app } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { logApiLine } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let apiChild = null;

export default async function spawn() {
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

export function killApi() {
    if (apiChild) {
        try { apiChild.kill(); } catch { }
        apiChild = null;
    }
}
