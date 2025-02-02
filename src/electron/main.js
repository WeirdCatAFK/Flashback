import { app, BrowserWindow } from "electron";
import path from "path";
import { isDev } from "./util.js";
import APIinstance from "../api/api.js";

// We start the backend process (node.js)
const api = new APIinstance({
  host: "",
  port: 50500,
  logFormat: "dev",
  isLocalhost: true,
});

try {
  await api.start();
  console.log("Backend process started successfully");
} catch (error) {
  console.error("Failed to start backend process:", error);
  app.quit();
}

// We initialize the frontend process (chromium)
app.on("ready", () => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
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
      console.log("Activating");
      mainWindow.loadURL("https://www.youtube.com/");
    } else {
      mainWindow.loadFile(path.join(app.getAppPath(), "dist-react/index.html"));
    }
  }
});

// Handle all windows closed
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    api.stop();
    app.quit();
  }
});
