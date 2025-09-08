//This is the entry point of the project
import { app, BrowserWindow } from "electron";
import { isDev } from "./utils.js";
import spawn from './../api/spawn.js';
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
  // We spawn the api process as a child process
  spawn();
  if (isDev()) {
    mainWindow.loadURL("http://localhost:51234");
  } else {
    mainWindow.loadFile("dist-react/index.html");
  }
});


// Closing the app 
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});