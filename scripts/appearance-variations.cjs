const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

app.commandLine.appendSwitch("disable-dev-shm-usage");

// Mock IPC handlers
ipcMain.handle("instances:load", () => []);
ipcMain.handle("instances:save", () => true);
ipcMain.handle("settings:load", () => ({ onboarding: { completed: true } }));
ipcMain.handle("settings:save", () => true);
ipcMain.handle("settings:detectJava", () => null);
ipcMain.handle("settings:dataDir", () => "/home/ubuntu/.minecraft");
ipcMain.handle("settings:storageInfo", () => ({ total: 100000, free: 50000 }));
ipcMain.handle("auth:restore", () => ({ id: "acc-1", name: "Native", type: "offline", isMicrosoft: false }));
ipcMain.handle("accounts:list", () => ({
  accounts: [{ id: "acc-1", name: "Native", type: "offline", isMicrosoft: false }],
  activeId: "acc-1"
}));
ipcMain.handle("updater:status", () => ({ status: "idle" }));
ipcMain.handle("updater:check", () => ({ hasUpdate: false }));
ipcMain.handle("wardrobe:get", () => ({ skins: [], capes: [] }));
ipcMain.handle("news:fetch", () => []);
ipcMain.handle("external:open", () => true);
ipcMain.on("window:minimize", () => {});
ipcMain.on("window:maximize", () => {});
ipcMain.on("window:close", () => {});

const themesToTest = [
  { name: "mint", accent: "#3ddc84", surface: "black" },
  { name: "ember", accent: "#ff7849", surface: "black" },
  { name: "rose", accent: "#f4679b", surface: "black" }
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 675,
    frame: false,
    show: true,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "..", "electron", "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ["--app-version=0.9.2"]
    }
  });

  const indexPath = path.join(__dirname, "..", "dist", "index.html");
  await win.loadURL("file://" + indexPath);
  await new Promise((r) => setTimeout(r, 2000));

  // Switch to versions tab
  await win.webContents.executeJavaScript(`(() => {
    const railButtons = Array.from(document.querySelectorAll(".rail-btn"));
    const versionsBtn = railButtons.find(
      (btn) =>
        btn.getAttribute("data-tooltip")?.toLowerCase().includes("version") ||
        btn.getAttribute("aria-label")?.toLowerCase().includes("version")
    ) || railButtons[3];
    if (versionsBtn) versionsBtn.click();
  })()`);

  await new Promise((r) => setTimeout(r, 2000));

  for (const theme of themesToTest) {
    console.log("Applying appearance theme:", theme.name);
    await win.webContents.executeJavaScript(`(() => {
      // Import and apply through appearance API
      const appearance = {
        accent: "${theme.accent}",
        surface: "${theme.surface}",
        contrast: "normal",
        radius: "soft",
        scale: 100,
        wallpaperDim: 72,
        animations: true,
        glow: true
      };
      // Write to localStorage
      localStorage.setItem("native.appearance", JSON.stringify(appearance));
      // Trigger apply
      document.documentElement.dataset.surface = appearance.surface;
      document.documentElement.style.setProperty("--brand", appearance.accent);
      document.documentElement.style.setProperty("--launch-gradient", "linear-gradient(135deg, " + appearance.accent + " 0%, " + appearance.accent + " 55%, #ffffff 100%)");
      document.documentElement.style.setProperty("--launch-shadow", appearance.accent + "88");
      document.documentElement.style.setProperty("--brand-glow", appearance.accent + "66");
    })()`);

    await new Promise((r) => setTimeout(r, 600));

    const shot = await win.webContents.capturePage();
    const outPath = path.join(__dirname, "..", "screenshot-theme-" + theme.name + ".png");
    fs.writeFileSync(outPath, shot.toPNG());
    console.log("Wrote", outPath);
  }

  app.quit();
});
