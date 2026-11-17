"use strict";

const windowsDesktop = Boolean(window.piWin);
const desktopPath = path => windowsDesktop ? path.replace(/\\/g, "/") : path;
const comparablePath = path => windowsDesktop ? desktopPath(path).toLowerCase() : path;
const fileName = path => desktopPath(path).split("/").filter(Boolean).at(-1);

const icons = {
  panel: "M4 5h16v14H4z M9 5v14",
  panelRight: "M4 5h16v14H4z M15 5v14",
  file: "M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6",
  plus: "M12 5v14 M5 12h14",
  folder: "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  chevron: "M6 9l6 6 6-6",
  up: "M12 19V5 M6 11l6-6 6 6",
  stop: "M7 7h10v10H7z",
  close: "M6 6l12 12 M18 6L6 18",
  copy: "M8 8h12v12H8z M16 8V4H4v12h4",
  check: "M5 12l5 5 9-10",
  settings: "M9.8 3.5h4.4l.6 2.5 1.5.9 2.5-.7 2.2 3.8-1.8 1.8v1.7l1.8 1.8-2.2 3.8-2.5-.7-1.5.9-.6 2.5H9.8l-.6-2.5-1.5-.9-2.5.7L3 15.3l1.8-1.8v-1.7L3 10l2.2-3.8 2.5.7 1.5-.9z M15 12.7a3 3 0 1 1-6 0 3 3 0 1 1 6 0",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 1 1 12 0 M14.3 14.3L20 20",
  appearance: "M4 4h16v16H4z M4 13l4-4 4 4 3-3 5 5",
  code: "M8 7l-5 5 5 5 M16 7l5 5-5 5 M13.5 4l-3 16",
  computer: "M3 5h18v12H3z M12 17v4 M8 21h8"
};

function drawIcon(parent, name, size = 16) {
  const canvas = document.createElement("canvas");
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.ceil(size * ratio);
  canvas.height = canvas.width;
  canvas.style.width = size + "px";
  canvas.style.height = size + "px";
  canvas.setAttribute("aria-hidden", "true");
  parent.replaceChildren(canvas);
  const context = canvas.getContext("2d");
  const scale = canvas.width / 24;
  context.scale(scale, scale);
  context.strokeStyle = getComputedStyle(parent).color || "#68655f";
  context.fillStyle = context.strokeStyle;
  context.lineWidth = name === "up" ? 2.25 : 1.65;
  context.lineCap = "round";
  context.lineJoin = "round";
  const path = new Path2D(icons[name]);
  if (name === "stop") context.fill(path);
  else context.stroke(path);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const markdownTags = new Set([
  "P", "BR", "HR", "STRONG", "EM", "DEL", "CODE", "PRE", "BLOCKQUOTE", "UL", "OL", "LI",
  "H1", "H2", "H3", "H4", "H5", "H6", "A", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"
]);

// Parse in a template and construct new nodes. The original markup stays inert.
function appendMarkdown(target, text) {
  try {
    const template = document.createElement("template");
    template.innerHTML = marked.parse(text, { gfm: true });
    const appendSafe = (parent, source) => {
      for (const child of source.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          parent.append(child.textContent);
        } else if (markdownTags.has(child.nodeName)) {
          const clean = element(child.nodeName.toLowerCase());
          if (child.nodeName === "A") {
            const url = child.getAttribute("href") ?? "";
            if (/^https?:\/\//i.test(url)) clean.href = url;
          } else if (child.nodeName === "OL" && Number(child.getAttribute("start")) > 1) {
            clean.start = Number(child.getAttribute("start"));
          }
          appendSafe(clean, child);
          parent.append(clean);
        }
      }
    };
    appendSafe(target, template.content);
  } catch {
    target.textContent = text;
  }
}

function messageText(content) {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).filter(block => block.type === "text")
    .map(block => block.text).join("\n\n");
}

function messageImage(content, className) {
  if (content.type !== "image" || !/^image\/(png|jpeg|gif|webp)$/.test(content.mimeType) ||
      typeof content.data !== "string") return null;
  const image = element("img", className);
  image.src = "data:" + content.mimeType + ";base64," + content.data;
  image.alt = content.name || "附加图片";
  return image;
}

const attachmentMarker = "\n\n[Pi Desktop 文件附件]\n";
const attachmentEnd = "\n[/Pi Desktop 文件附件]";

function attachedPrompt(prompt, attachments) {
  const files = attachments.filter(item => item.type === "file").map(({ name, text }) => ({ name, text }));
  return files.length ? (prompt || "请查看附件。") + attachmentMarker + JSON.stringify(files) + attachmentEnd : prompt;
}

function messageAttachments(text) {
  const start = text.lastIndexOf(attachmentMarker);
  const end = text.indexOf(attachmentEnd, start + attachmentMarker.length);
  if (start < 0 || end < 0) return { prompt: text, files: [] };
  try {
    const files = JSON.parse(text.slice(start + attachmentMarker.length, end));
    if (Array.isArray(files) && files.every(file => typeof file?.name === "string" && typeof file.text === "string")) {
      return { prompt: text.slice(0, start), files };
    }
  } catch { /* Older and manually typed messages remain visible as written. */ }
  return { prompt: text, files: [] };
}
