const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

app.commandLine.appendSwitch("disable-dev-shm-usage");

// Mock IPC handlers so App loads directly into Shell
ipcMain.handle("instances:load", () => [
  {
    id: "cluster-1-21-1-fabric",
    name: "Tricky Trials",
    version: "1.21.1",
    mc_version: "1.21.1",
    loader: "Fabric",
    mc_loader: "Fabric"
  }
]);
ipcMain.handle("instances:save", () => true);
ipcMain.handle("settings:load", () => ({
  onboarding: { completed: true }
}));
ipcMain.handle("settings:save", () => true);
ipcMain.handle("settings:detectJava", () => null);
ipcMain.handle("settings:dataDir", () => "/home/ubuntu/.minecraft");
ipcMain.handle("settings:storageInfo", () => ({ total: 100000, free: 50000 }));
ipcMain.handle("auth:restore", () => ({
  id: "acc-1",
  name: "Native",
  type: "offline",
  isMicrosoft: false
}));
ipcMain.handle("auth:login", () => null);
ipcMain.handle("auth:logout", () => true);
ipcMain.handle("accounts:list", () => ({
  accounts: [
    { id: "acc-1", name: "Native", type: "offline", isMicrosoft: false }
  ],
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

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 675,
    frame: false,
    show: true,
    backgroundColor: "#060305",
    webPreferences: {
      preload: path.join(__dirname, "..", "electron", "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ["--app-version=0.9.2"]
    }
  });

  const indexPath = path.join(__dirname, "..", "dist", "index.html");
  console.log("Loading", indexPath);
  await win.loadURL("file://" + indexPath);
  console.log("Loaded app page");

  // Wait for initial render
  await new Promise((r) => setTimeout(r, 2000));

  // Switch to Versions tab
  const switchResult = await win.webContents.executeJavaScript(`(() => {
    const railButtons = Array.from(document.querySelectorAll(".rail-btn"));
    const versionsBtn = railButtons.find(
      (btn) =>
        btn.getAttribute("data-tooltip")?.toLowerCase().includes("version") ||
        btn.getAttribute("aria-label")?.toLowerCase().includes("version")
    ) || railButtons[3];

    if (versionsBtn) {
      versionsBtn.click();
      return "switched to versions";
    }
    return "versions button not found (" + railButtons.length + " buttons)";
  })()`);
  console.log("Tab switch result:", switchResult);

  // Wait for versions grid to render
  await new Promise((r) => setTimeout(r, 2500));

  // Capture closed state screenshot
  const shotClosed = await win.webContents.capturePage();
  const outClosed = path.join(__dirname, "..", "screenshot-versions-view.png");
  fs.writeFileSync(outClosed, shotClosed.toPNG());
  console.log("Wrote screenshot-versions-view.png", shotClosed.getSize());

  // Open patch dropdown on 1.21 card
  const openResult = await win.webContents.executeJavaScript(`(() => {
    const cards = Array.from(document.querySelectorAll(".version-card"));
    const card121 = cards.find((c) =>
      c.querySelector(".version-card-center-numeral")?.textContent?.includes("1.21")
    );
    if (card121) {
      const chip = card121.querySelector(".version-patch-chip");
      if (chip) {
        chip.click();
        return "clicked 1.21 patch chip";
      }
      return "chip not found in 1.21 card";
    }
    return "1.21 card not found (cards: " + cards.length + ")";
  })()`);
  console.log("Dropdown open result:", openResult);

  // Wait for dropdown animation
  await new Promise((r) => setTimeout(r, 600));

  // Capture open dropdown screenshot matching mockup c65d
  const shotOpen = await win.webContents.capturePage();
  const outOpen = path.join(__dirname, "..", "screenshot-versions-dropdown.png");
  fs.writeFileSync(outOpen, shotOpen.toPNG());
  console.log("Wrote screenshot-versions-dropdown.png", shotOpen.getSize());

  app.quit();
});
