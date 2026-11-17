import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const engine = dirname(fileURLToPath(import.meta.url));
const toolFactories = {
  read: "createReadToolDefinition", bash: "createBashToolDefinition", edit: "createEditToolDefinition",
  write: "createWriteToolDefinition", grep: "createGrepToolDefinition", find: "createFindToolDefinition", ls: "createLsToolDefinition"
};

export const sandboxedNames = new Set(Object.keys(toolFactories));

export function toolDefinition(sdk, name, cwd, settings, confined = false) {
  const options = name === "bash" ? {
    ...(settings.shell ?? {}),
    exposeSessionEnvironment: !confined
  } : name === "read" ? { autoResizeImages: settings.resizeImages } : undefined;
  return sdk[toolFactories[name]](cwd, options);
}

export async function loadPiSDK() {
  const cli = await realpath(process.argv[1]);
  let root = dirname(cli);
  while (root !== dirname(root)) {
    const data = await readFile(join(root, "package.json"), "utf8").catch(() => "");
    const manifest = data ? JSON.parse(data) : null;
    if (manifest?.name === "@earendil-works/pi-coding-agent") {
      const entry = resolve(root, manifest.exports?.["."]?.import ?? manifest.main);
      let modules = dirname(root);
      while (modules !== dirname(modules) && basename(modules) !== "node_modules") modules = dirname(modules);
      if (modules === dirname(modules)) modules = root;
      return { entry, modules, sdk: await import(pathToFileURL(entry).href) };
    }
    root = dirname(root);
  }
  throw new Error("找不到当前 Pi 安装的工具 SDK。");
}

export async function desktopBundlePath() {
  const path = await readFile(join(engine, ".bundle-location"), "utf8").catch(() => "");
  if (isAbsolute(path) && basename(path).toLowerCase().endsWith(".app")) return realpath(path).catch(() => path);
  const bundled = resolve(engine, "../../..");
  return basename(bundled).toLowerCase().endsWith(".app") ? bundled : null;
}

const workspaceWrites = `
(allow file-write*
  (require-all
    (subpath (param "WORKSPACE"))
    (require-not (literal (param "WORKSPACE")))
    (require-not (subpath (param "ENGINE")))
    (require-not (subpath (param "PROTECTED_APP")))
    (require-not (subpath (param "MODULES")))
    (require-not (literal (param "NODE")))
    (require-not (regex #"/[.]([Gg][Ii][Tt]|[Pp][Ii]|[Cc][Oo][Dd][Ee][Xx]|[Aa][Gg][Ee][Nn][Tt][Ss])(/|$)"))))
`;

function contains(root, path) {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep);
}

export async function createSandbox(installation, cwd, scratch) {
  const [workspace, home, executable, resources, profile, bundle] = await Promise.all([
    realpath(cwd), realpath(homedir()), realpath(process.execPath), realpath(engine),
    readFile(join(engine, "tool-sandbox.sbpl"), "utf8"), desktopBundlePath()
  ]);
  const nodeLib = join(dirname(dirname(executable)), "lib");
  const piBin = resolve(home, ".pi", "agent", "bin");
  const path = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  const environment = {
    HOME: home, TMPDIR: scratch,
    PI_CODING_AGENT_DIR: scratch,
    PATH: [...new Set([piBin, dirname(executable), ...path, "/usr/bin", "/bin"])].join(delimiter),
    LANG: "en_US.UTF-8"
  };
  const scope = {
    ENGINE: resources, PROTECTED_APP: bundle ?? resources, MODULES: installation.modules,
    NODE: executable, NODE_LIB: nodeLib, PI_BIN: piBin,
    WORKSPACE: workspace, SCRATCH: scratch
  };
  const args = Object.entries(scope).flatMap(([key, value]) => ["-D", key + "=" + value]);
  return {
    workspaceWritable: !contains(workspace, home),
    args,
    profile,
    workspace,
    executable,
    environment,
    entry: installation.entry
  };
}

function processError(text) {
  return /sandbox-exec:|Operation not permitted|Permission denied|\bEPERM\b|\bEACCES\b/i.test(text)
    ? "沙箱拒绝了这次操作。需要越界时，请切换手动模式后确认。\n" + text
    : text;
}

export async function runSandboxedTool(sandbox, request, allowWrites, signal, onUpdate) {
  if (signal?.aborted) throw new Error("操作已取消。");
  const payload = JSON.stringify(request);
  const child = spawn("/usr/bin/sandbox-exec", [
    ...sandbox.args, "-p", sandbox.profile + (allowWrites && sandbox.workspaceWritable ? workspaceWrites : ""),
    sandbox.executable, join(engine, "sandbox-worker.mjs"), sandbox.entry
  ], {
    cwd: sandbox.workspace, env: sandbox.environment, stdio: ["pipe", "pipe", "pipe"]
  });

  return new Promise((resolve, reject) => {
    let result;
    let failure;
    let stderr = "";
    let abortTimer;
    const abort = () => {
      child.kill("SIGTERM");
      abortTimer = setTimeout(() => child.kill("SIGKILL"), 1200);
      abortTimer.unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", error => { failure = error.message; });
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === "update") onUpdate?.(message.value);
      if (message.type === "result") result = message.value;
      if (message.type === "error") failure = message.error;
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(abortTimer);
      signal?.removeEventListener("abort", abort);
      lines.close();
      if (signal?.aborted) { reject(new Error("操作已取消。")); return; }
      if (code === 0 && result) { resolve(result); return; }
      const message = failure || stderr.trim() || "沙箱工具未完成（" + (exitSignal || "退出码 " + code) + "）。";
      reject(new Error(processError(message)));
    });
    child.stdin.end(payload);
  });
}
