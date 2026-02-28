// This is the entry point of the project
import { app, BrowserWindow } from "electron";
import { isDev } from "./utils.js";
import spawn from './../api/spawn.js';

// Global reference to prevent garbage collection
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    titleBarOverlay: {
      color: "#000000",
      symbolColor: "#FFFFFF",
      height: 30,
    },
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
  });

  // Load the frontend
  if (isDev()) {
    mainWindow.loadURL("http://localhost:51234");
  } else {
    mainWindow.loadFile("dist-react/index.html");
  }
}

// Ensure only one instance runs
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // Handle second instance launch (focus the existing window)
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // App Initialization
  app.on("ready", () => {
    // Spawn the API process once
    spawn();

    // Create the window
    createWindow();
  });

  // MacOS: Re-create window on dock click
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

// Closing the app 
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});