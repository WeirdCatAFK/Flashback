import { app, BrowserWindow } from "electron";
import path from "path";
import isDev from "./util.js";
import BackendAPI from "../api/server.js";

let backendServer = null;

async function startBackendServer() {
  backendServer = new BackendAPI({
    port: 50500,
    logFormat: "dev",
  });

  try {
    await backendServer.start();
    console.log("Backend server started successfully in main process");
  } catch (error) {
    console.error("Failed to start backend server:", error);
    app.quit();
  }
}

await startBackendServer();

// Main app initialization
app.on("ready", () => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#FBF6EE",
      symbolColor: "#000",
      height: 20,
    },
    webPreferences: {
      nodeIntegration: true,
    },
  });
  if (isDev()) {
    mainWindow.loadURL("http://localhost:51234");
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), "dist-react/index.html"));

  }
});

// Recreate window on activate (macOS specific)
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const mainWindow = new BrowserWindow({});
    if (isDev()) {
      console.log("Activating")
      mainWindow.loadURL("http://localhost:51234");
    } else {
      mainWindow.loadFile(
        path.join(app.getAppPath(), "dist-react/index.html")
      );
    }
  }
});

// Handle all windows closed
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
