import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAA+UlEQVR4nO3RQQ0AIAzAwLlCGYZRgow9ekkFNLk592mxWT+IBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtPkQJhc7Y5tbkAAAAAElFTkSuQmCCResources/Web/index", "base64");
const fixture = await mkdtemp(join(tmpdir(), "pi-desktop-check-"));
const profile = join(fixture, "profile");
const workspace = join(fixture, "Project & Space");
const photo = join(fixture, "sample.png");
const note = join(fixture, "attachment.txt");
const report = join(workspace, "report.txt");
const code = "PI-WINDOWS-ATTACHMENT-412";
const completed = "PI_WINDOWS_PACKAGE_OK";
let sawAttachments = false;

const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { model, messages } = JSON.parse(Buffer.concat(chunks).toString());
    const last = messages.at(-1);
    const base = { id: "pi-windows-check", object: "chat.completion.chunk", created: 1, model };
    let delta, finish;
    if (last.role === "tool") {
      delta = { role: "assistant", content: completed };
      finish = "stop";
    } else {
      const input = messages.findLast(message => message.role === "user")?.content;
      assert(Array.isArray(input));
      assert(input.some(item => item.type === "text" && item.text.includes(code)), "document text missing from the model request");
      assert(input.some(item => item.type === "image_url" && item.image_url.url.startsWith("data:image/")), "image missing from the model request");
      sawAttachments = true;
      delta = { role: "assistant", tool_calls: [{ id: "call_write", index: 0, type: "function",
        function: { name: "write", arguments: JSON.stringify({ path: "report.txt", content: code }) }
      }] };
      finish = "tool_calls";
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const row of [
      { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }],
        usage: { prompt_tokens: 2300, completion_tokens: 20, total_tokens: 2320 } }
    ]) response.write("data: " + JSON.stringify(row) + "\n\n");
    response.end("data: [DONE]\n\n");
  } catch (error) {
    console.error(error);
    response.writeHead(400).end(error.message);
  }
});

let app, page;
try {
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  await Promise.all([mkdir(profile), mkdir(workspace), writeFile(photo, png), writeFile(note, code)]);
  await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { "package-check": {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture",
    models: [{ id: "local-vision", name: "Package Check", input: ["text", "image"], contextWindow: 128000, maxTokens: 8192 }]
  } } }));
  await writeFile(join(profile, "settings.json"), JSON.stringify({ defaultProvider: "package-check", defaultModel: "local-vision" }));
  app = await electron.launch({ executablePath: resolve(process.argv[2]), timeout: 30000,
    args: ["--disable-gpu", `--user-data-dir=${join(fixture, "desktop")}`],
    env: { ...process.env, PI_CODING_AGENT_DIR: profile }
  });
  page = await app.firstWindow();
  page.on("pageerror", error => console.error("Renderer:", error.message));
  const manual = page.locator('#tool-mode[aria-label="权限模式 手动"]:enabled');
  await manual.waitFor({ timeout: 30000 });
  await manual.click();
  await page.locator("#mode-options button:disabled").filter({ hasText: "自动" }).waitFor();
  await page.keyboard.press("Escape");

  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, workspace);
  await page.locator("#folder").click();
  await page.locator("#folder").filter({ hasText: "Project & Space" }).waitFor();
  await manual.waitFor();
  await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [photo, note]);
  await page.locator("#attach").click();
  await page.locator("#attachments img").waitFor();
  await page.locator("#attachments").getByText("attachment.txt").waitFor();
  await page.locator("#prompt").fill("Create the requested report.");
  await page.locator("#send").click();
  await page.locator("#extension-dialog[open]").getByText("允许工具执行？").waitFor({ timeout: 30000 });
  await assert.rejects(access(report));
  await page.locator('#extension-dialog button[value="ok"]').click();
  await page.locator(".answer").getByText(completed).waitFor({ timeout: 30000 });
  assert(sawAttachments);
  assert.equal(await readFile(report, "utf8"), code);
  await page.locator("#history button").first().waitFor();
  await page.locator("#new-chat").click();
  await manual.waitFor();
  await page.locator("#history button").first().click();
  await page.locator(".answer").getByText(completed).waitFor();
  console.log("The installed Windows package started Pi RPC, sent both attachments, waited for approval, wrote in the workspace, and reopened the saved session.");
} catch (error) {
  if (page && !page.isClosed()) console.error("Pi status:", await page.locator("#feedback-text").textContent().catch(() => ""));
  throw error;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise(ok => server.close(ok));
  await rm(fixture, { recursive: true, force: true, maxRetries: 4 });
}
