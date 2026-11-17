import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

const packageName = "@earendil-works/pi-coding-agent";
const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

async function findPi() {
  const directories = new Set([
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".pi", "agent", "bin"),
    process.env.APPDATA && join(process.env.APPDATA, "npm")
  ].filter(path => path && isAbsolute(path)));

  for (const dir of directories) {
    const executable = join(dir, "pi.exe");
    if (await access(executable).then(() => true, () => false)) return { executable };
    const batch = join(dir, "pi.cmd");
    if (await access(batch).then(() => true, () => false)) {
      const root = join(dir, "node_modules", packageName);
      // npm shims have a JS entry point. A standalone Pi installer can ship its own batch launcher.
      const manifest = await readFile(join(root, "package.json"), "utf8").then(JSON.parse).catch(() => null);
      const entry = manifest?.name === packageName && (typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi);
      if (entry) {
        for (const bin of [dir, ...directories]) {
          const node = join(bin, "node.exe");
          if (await access(node).then(() => true, () => false)) return { executable: node, entry: join(root, entry) };
        }
        throw new Error("Pi CLI 需要 Node.js。请先在终端运行 pi --version 确认安装。");
      }
      return { batch };
    }
  }
  throw new Error("找不到本机的 pi 命令。请先安装 Pi CLI 并在终端运行 pi --version。");
}

function command(launcher, args, env) {
  if (!launcher.batch) return [launcher.executable, launcher.entry ? [launcher.entry, ...args] : args, false];

  // Parameter values never become cmd.exe syntax. The batch path and each argument are expanded once inside quotes.
  const names = [launcher.batch, ...args].map((value, index) => {
    const key = `PI_DESKTOP_ARG_${index}`;
    env[key] = value;
    return `"%${key}%"`;
  });
  return [join(system32, "cmd.exe"), ["/d", "/v:off", "/s", "/c", `"${names.join(" ")}"`], true];
}

export async function spawnPi(folder, session, extension, onLine) {
  const env = { ...process.env, NO_COLOR: "1" };
  const args = ["--mode", "rpc", "--extension", extension, ...(session ? ["--session", session] : [])];
  const [executable, argv, windowsVerbatimArguments] = command(await findPi(), args, env);
  const child = spawn(executable, argv, { cwd: folder, env, windowsHide: true, windowsVerbatimArguments,
    stdio: ["pipe", "pipe", "pipe"] });
  let detail = "";
  child.stdin.on("error", () => {});
  child.stderr.setEncoding("utf8").on("data", data => { detail = (detail + data).slice(-4096); });
  child.on("error", error => { detail = error.message; });
  const exited = new Promise(resolve => child.once("close", (status, signal) => resolve({ status: status ?? signal ?? 1, detail })));
  createInterface({ input: child.stdout }).on("line", onLine);
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });

  return {
    exited,
    send(record) {
      if (!child.stdin.writable) throw new Error("Pi 已断开连接。");
      return new Promise((resolve, reject) => child.stdin.write(JSON.stringify(record) + "\n",
        error => error ? reject(error) : resolve(null)));
    },
    async stop(abort = false) {
      if (child.stdin.writable) child.stdin.end(abort ? '{"type":"abort"}\n' : "");
      const timeout = setTimeout(() => {
        if (child.exitCode !== null) return;
        const kill = spawn(join(system32, "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        kill.on("error", () => child.kill());
        kill.on("exit", code => { if (code !== 0 && child.exitCode === null) child.kill(); });
      }, 3000);
      try { await exited; } finally { clearTimeout(timeout); }
    }
  };
}
