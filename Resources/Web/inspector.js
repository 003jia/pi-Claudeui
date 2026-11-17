"use strict";

(() => {
  const panel = document.getElementById("inspector");
  const trigger = document.getElementById("show-inspector");
  const handle = document.getElementById("inspector-resizer");
  const changes = new Map();
  const deliverables = new Map();

  function show(visible, context = false) {
    panel.hidden = !visible;
    trigger.setAttribute("aria-expanded", String(visible));
    if (context) {
      const section = document.getElementById("inspector-context");
      section.focus({ preventScroll: true });
      section.scrollIntoView({ block: "nearest" });
    }
  }

  function resize(width) {
    const value = Math.max(232, Math.min(420, width));
    panel.style.setProperty("--inspector-width", value + "px");
    handle.setAttribute("aria-valuenow", value);
  }

  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", event => {
    if (handle.hasPointerCapture(event.pointerId)) resize(Math.round(panel.getBoundingClientRect().right - event.clientX));
  });
  handle.addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    resize(Number(handle.getAttribute("aria-valuenow")) + (event.key === "ArrowLeft" ? 12 : -12));
  });

  function reveal(path) {
    return host("revealWorkspaceEntry", path ? { path } : {}).catch(error => feedback(error.message, true));
  }

  function entries(id, records, empty) {
    const target = document.getElementById(id);
    target.replaceChildren();
    if (records.size === 0) target.append(element("p", "inspector-empty", empty));
    for (const [path, label] of records) {
      const row = element("button", "inspector-entry");
      row.type = "button";
      row.title = path;
      const icon = element("span");
      icon.dataset.icon = "file";
      row.append(icon, element("span", "button-label", label));
      row.addEventListener("click", () => reveal(path));
      target.append(row);
      drawIcon(icon, "file", 14);
    }
  }

  function reset(folder) {
    const path = document.getElementById("inspector-path");
    path.textContent = folder;
    path.title = folder;
    document.getElementById("inspector-folder").textContent = fileName(folder) || "/";
    changes.clear();
    deliverables.clear();
    entries("inspector-changes", changes, "还没有记录的文件改动");
    entries("inspector-deliverables", deliverables, "暂无交付文件");
  }

  function workspaceFile(path) {
    path = desktopPath(path);
    if (!path || path.startsWith("~") || /[\u0000\r\n]/.test(path) || path.split("/").includes("..")) return null;
    const absolute = path.startsWith("/") || (windowsDesktop && /^[A-Za-z]:\//.test(path));
    const folder = comparablePath(state.folder).replace(/\/$/, "") + "/";
    if (absolute && !comparablePath(path).startsWith(folder)) return null;
    return path;
  }

  function recordChange(tool, path) {
    if (tool !== "write" && tool !== "edit") return;
    const file = typeof path === "string" && workspaceFile(path);
    if (!file || changes.has(file)) return;
    changes.set(file, fileName(file));
    entries("inspector-changes", changes, "还没有记录的文件改动");
  }

  function recordLinks(text) {
    let updated = false;
    marked.walkTokens(marked.lexer(text), token => {
      if (token.type !== "link" || !token.href || /^(?:\/\/|#)/.test(token.href)) return;
      const drivePath = windowsDesktop && /^[a-z]:[/\\]/i.test(token.href);
      if (/^[a-z][a-z0-9+.-]*:/i.test(token.href) && !drivePath && !token.href.startsWith("file:///")) return;
      const path = token.href.replace(/^file:\/\/\//i, windowsDesktop ? "" : "/");
      let file;
      try { file = workspaceFile(decodeURIComponent(path)); } catch { return; }
      if (!file || deliverables.has(file)) return;
      deliverables.set(file, token.text || fileName(file));
      updated = true;
    });
    if (updated) entries("inspector-deliverables", deliverables, "暂无交付文件");
  }

  trigger.addEventListener("click", () => show(panel.hidden));
  document.getElementById("hide-inspector").addEventListener("click", () => { show(false); trigger.focus(); });
  document.getElementById("reveal-workspace").addEventListener("click", () => reveal());
  document.addEventListener("DOMContentLoaded", () => show(matchMedia("(min-width: 1020px)").matches));
  window.piInspector = { reset, recordChange, recordLinks, show };
})();
