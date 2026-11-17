import { access, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const home = homedir();
export const choices = {
  sendShortcut: ["enter", "command-enter"], sidebarOnLaunch: ["show", "hide"], replyFont: ["serif", "system"],
  chatWidth: ["standard", "compact", "wide"], codeSize: ["12", "14", "16"]
};

const readJSON = path => readFile(path, "utf8").then(JSON.parse).catch(() => null);
const absolute = (path, cwd) => resolve(cwd, path.replace(/^~(?=[\\/]|$)/, home));

export const isDirectory = path => stat(path).then(data => data.isDirectory(), () => false);

export async function sessionRoot(folder) {
  const agent = process.env.PI_CODING_AGENT_DIR ? absolute(process.env.PI_CODING_AGENT_DIR, home) : join(home, ".pi", "agent");
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return absolute(process.env.PI_CODING_AGENT_SESSION_DIR, folder);
  for (const file of [join(folder, ".pi", "settings.json"), join(agent, "settings.json")]) {
    const settings = await readJSON(file);
    if (typeof settings?.sessionDir === "string" && settings.sessionDir) return absolute(settings.sessionDir, folder);
  }
  return join(agent, "sessions");
}

export async function loadPreferences(path) {
  const saved = await readJSON(path);
  const preferences = Object.fromEntries(Object.entries(choices).map(([key, values]) =>
    [key, values.includes(saved?.preferences?.[key]) ? saved.preferences[key] : values[0]]));
  const folder = typeof saved?.folder === "string" && isAbsolute(saved.folder) && await isDirectory(saved.folder) ? saved.folder : home;
  return { folder, preferences };
}

export async function savePreferences(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + ".tmp", JSON.stringify(state));
  await rename(path + ".tmp", path);
}

async function preview(path) {
  const file = await open(path, "r");
  let data;
  try {
    const buffer = Buffer.alloc(512 * 1024);
    const { bytesRead } = await file.read(buffer);
    data = buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
  const lines = data.split(/\r?\n/);
  const start = JSON.parse(lines.shift());
  if (start.type !== "session" || typeof start.cwd !== "string" || !isAbsolute(start.cwd)) return null;
  let name = "", prompt = "";
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
    if (entry.message?.role === "user" && !prompt) {
      const content = entry.message.content;
      prompt = typeof content === "string" ? content : content?.filter(block => block.type === "text").map(block => block.text).join(" ") ?? "";
    }
  }
  const title = (name || prompt.split("\n\n[Pi Desktop 文件附件]\n")[0]).replace(/\s+/g, " ").trim().slice(0, 110);
  return { path, folder: start.cwd, title: title || "未命名会话" };
}

export async function recentSessions(root) {
  const files = [];
  const next = [root];
  while (next.length) {
    const dir = next.pop();
    const children = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.name.startsWith(".") || child.isSymbolicLink()) continue;
      const path = join(dir, child.name);
      if (child.isDirectory()) next.push(path);
      else if (child.isFile() && child.name.endsWith(".jsonl")) {
        const modified = await stat(path).then(value => value.mtimeMs, () => 0);
        files.push({ path, modified });
      }
    }
  }
  const sorted = files.sort((a, b) => b.modified - a.modified).slice(0, 80);
  return (await Promise.all(sorted.map(file => preview(file.path).catch(() => null)))).filter(Boolean);
}

export async function workspaceEntry(folder, path) {
  const root = await realpath(folder);
  const target = path ? await realpath(resolve(root, path)) : root;
  const part = relative(root, target);
  if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error("文件不在当前工作目录内。");
  await access(target);
  return target;
}
