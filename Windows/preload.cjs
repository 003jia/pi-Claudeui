const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piWin", {
  postMessage: request => ipcRenderer.invoke("pi-host", request),
  receive(callback) {
    ipcRenderer.on("pi-event", (_event, name, data) => {
      if (["receive", "disconnected", "menu"].includes(name)) callback(name, data);
    });
  }
});
