//This is the entry point of the project
import { app, BrowserWindow } from "electron";
import { exec } from "child_process";
import { isDev } from "./utils.js";

// We initialize the fronted process (chromium)
app.on("ready", () => {
  const mainWindow = new BrowserWindow({
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
      contextIsolation: false,
      enableRemoteModule: true,
    },
  });
  if (isDev()) {
    mainWindow.loadURL("http://localhost:51234");
  } else {
    mainWindow.loadFile("dist-react/index.html");
  }
});

// Closing the app properly
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});