import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, shell } from "electron";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachmentLimit, readAttachments } from "./attachments.mjs";
import { spawnPi } from "./pi-process.mjs";
import { choices, home, isDirectory, loadPreferences, recentSessions, savePreferences, sessionRoot, workspaceEntry } from "./storage.mjs";

const index = "pi-desktop://app/index.html";
const packaged = app.isPackaged ? process.resourcesPath : fileURLToPath(new URL("../Resources", import.meta.url));
const mimeTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

protocol.registerSchemesAsPrivileged([{ scheme: "pi-desktop", privileges: { standard: true, secure: true } }]);

async function start() {
  await app.whenReady();
  protocol.handle("pi-desktop", async request => {
    const url = new URL(request.url);
    const type = mimeTypes[extname(url.pathname)];
    if (url.host !== "app" || url.search || !/^\/[a-zA-Z0-9.-]+$/.test(url.pathname) || !type) return new Response(null, { status: 404 });
    try {
      const bytes = await readFile(join(packaged, "Web", url.pathname.slice(1)));
      return new Response(bytes, { headers: { "Content-Type": `${type}; charset=utf-8` } });
    } catch { return new Response(null, { status: 404 }); }
  });

  const prefsPath = join(app.getPath("userData"), "desktop-preferences.json");
  const saved = await loadPreferences(prefsPath);
  const extension = await realpath(join(packaged, "Engine", "permission-modes.mjs"));
  let preferencesSave = Promise.resolve();
  let active = null;
  let switching = null;
  let closing = false;
  let knownSessions = new Map();
  const win = new BrowserWindow({
    width: 1140, height: 770, minWidth: 640, minHeight: 490, title: "Pi", backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: { preload: fileURLToPath(new URL("preload.cjs", import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });

  function deliver(name, data) {
    if (!win.isDestroyed()) win.webContents.send("pi-event", name, data);
  }

  function persist() {
    const snapshot = structuredClone(saved);
    preferencesSave = preferencesSave.catch(() => {}).then(() => savePreferences(prefsPath, snapshot));
    return preferencesSave;
  }

  async function launch(request) {
    const { folder, session, generation } = request;
    if (typeof generation !== "string" || typeof folder !== "string" || !isAbsolute(folder)) {
      throw new Error("无法切换会话，工作目录无效或 Pi 正在连接。");
    }
    if (session != null && knownSessions.get(session) !== folder) throw new Error("会话文件不在历史列表中。");
    if (!await isDirectory(folder)) throw new Error("工作目录已移动或删除。请选择可用的文件夹。");
    const previous = active;
    active = null;
    if (previous) await previous.stop();
    if (closing) throw new Error("Pi 正在退出。");
    const next = await spawnPi(folder, session, extension, line => deliver("receive", { generation, records: [line] }));
    active = next;
    next.exited.then(result => {
      if (active !== next) return;
      active = null;
      if (!closing) deliver("disconnected", { generation, ...result });
    });
    saved.folder = folder;
    await persist().catch(() => {});
    return { sessionDirectory: await sessionRoot(folder), permissionExtension: extension, nativeSandbox: false };
  }

  ipcMain.handle("pi-host", async (event, request) => {
    if (closing || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame.url !== index || typeof request?.action !== "string") throw new Error("无法验证 Pi 窗口请求。");
    switch (request.action) {
      case "initial": return { ...saved, home, sessionDirectory: await sessionRoot(saved.folder) };
      case "launch":
        if (switching) throw new Error("Pi 正在切换会话。");
        switching = launch(request);
        try { return await switching; } finally { switching = null; }
      case "rpc":
        if (switching || !active || typeof request.record?.type !== "string") throw new Error("Pi 尚未连接。");
        return active.send(request.record);
      case "setDesktopPreference":
        if (!Object.hasOwn(choices, request.key) || !choices[request.key].includes(request.value)) throw new Error("此设置值不可用。");
        saved.preferences[request.key] = request.value;
        await persist();
        return null;
      case "history": {
        const folder = saved.folder;
        const history = await recentSessions(await sessionRoot(folder));
        if (folder !== saved.folder) return [];
        knownSessions = new Map(history.map(item => [item.path, item.folder]));
        return history;
      }
      case "chooseFolder": {
        const result = await dialog.showOpenDialog(win, { defaultPath: saved.folder, properties: ["openDirectory"], buttonLabel: "选择" });
        return result.canceled ? null : result.filePaths[0];
      }
      case "chooseAttachments": {
        const limit = Number.isInteger(request.limit) ? Math.max(1, Math.min(attachmentLimit, request.limit)) : 1;
        const result = await dialog.showOpenDialog(win, { defaultPath: saved.folder, title: "添加图片或文件", buttonLabel: "添加",
          properties: limit > 1 ? ["openFile", "multiSelections"] : ["openFile"] });
        return result.canceled ? null : readAttachments(result.filePaths, limit);
      }
      case "revealWorkspaceEntry": {
        const path = await workspaceEntry(saved.folder, request.path);
        if (request.path) shell.showItemInFolder(path);
        else {
          const error = await shell.openPath(path);
          if (error) throw new Error(error);
        }
        return null;
      }
      case "revealSessions": {
        const path = await sessionRoot(saved.folder);
        if (!await isDirectory(path)) throw new Error("当前会话目录尚未建立。");
        const error = await shell.openPath(path);
        if (error) throw new Error(error);
        return null;
      }
      case "copy":
        if (typeof request.text !== "string") throw new Error("没有可复制的内容。");
        clipboard.writeText(request.text);
        return null;
      default: throw new Error("此操作不可用。");
    }
  });

  win.webContents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url === index) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  const action = (label, accelerator, name) => ({ label, accelerator, click: () => deliver("menu", { action: name }) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "文件", submenu: [action("新建对话", "Ctrl+N", "newSession"), action("选择工作目录", "Ctrl+O", "chooseFolder"),
      action("设置", "Ctrl+,", "settings"), { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" }
  ]));
  app.on("second-instance", () => { if (win.isMinimized()) win.restore(); win.focus(); });
  win.on("close", async event => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    await switching?.catch(() => {});
    await Promise.allSettled([preferencesSave, active?.stop(true)]);
    win.close();
  });
  app.on("window-all-closed", () => app.quit());
  await win.loadURL(index);
}

if (app.requestSingleInstanceLock()) {
  void start().catch(error => {
    dialog.showErrorBox("Pi 未能启动", error.message);
    app.exit(1);
  });
} else app.quit();
