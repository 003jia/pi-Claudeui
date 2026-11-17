import { pathToFileURL } from "node:url";
import { toolDefinition } from "./sandbox-runner.mjs";

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
const send = (type, value) => process.stdout.write(JSON.stringify({ type, value }) + "\n");

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { name, id, input, settings, model } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const sdk = await import(pathToFileURL(process.argv[2]).href);
  const cwd = process.cwd();
  const tool = toolDefinition(sdk, name, cwd, settings, true);
  const result = await tool.execute(id, input, controller.signal, value => send("update", value), { cwd, model });
  send("result", result);
} catch (error) {
  process.stdout.write(JSON.stringify({ type: "error", error: error.message }) + "\n");
  process.exitCode = 1;
}
