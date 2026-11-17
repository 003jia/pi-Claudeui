"use strict";

const byId = id => document.getElementById(id);
const ui = Object.fromEntries([
  "layout", "workspace", "welcome", "transcript", "messages", "history", "history-empty", "conversation-title",
  "prompt", "composer", "folder", "folder-label", "new-chat", "model", "model-label", "model-menu", "model-options",
  "model-filter", "attach", "attachments", "send", "feedback", "feedback-text", "reconnect",
  "hide-sidebar", "show-sidebar", "open-settings-collapsed", "extension-dialog", "dialog-title", "dialog-text", "dialog-options"
].map(id => [id, byId(id)]));

const state = {
  home: "", folder: "", sessionDirectory: "", opened: null, sessionPath: null, generation: "", connected: false, loading: true,
  busy: false, stopping: false, settingModel: false, model: null, thinkingLevel: "off", models: [], attachments: [], attaching: false, chats: [],
  activeMessage: null, tools: new Map(), pending: new Map(), dialogs: [], nextRequest: 0
};
const attachmentLimit = 4;
const imageModelMessage = "当前模型只接收文字。请选择支持图片输入的模型，附件会留在这里。";

function host(action, fields = {}) {
  const channel = window.piWin ?? window.webkit.messageHandlers.piHost;
  return channel.postMessage({ action, ...fields });
}

function rpc(type, fields = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const id = String(++state.nextRequest);
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error("Pi 响应超时，请稍后重试。"));
    }, timeout);
    state.pending.set(id, (failure, result) => {
      clearTimeout(timer);
      if (failure) reject(new Error(failure));
      else resolve(result);
    });
    host("rpc", { record: { type, id, ...fields } }).catch(error => {
      const handle = state.pending.get(id);
      state.pending.delete(id);
      handle?.(error.message || String(error));
    });
  });
}

function failRequests(message) {
  for (const reply of state.pending.values()) reply(message);
  state.pending.clear();
}

function feedback(message = "", error = false, retry = false) {
  ui.feedback.hidden = !message;
  ui.feedback.dataset.error = String(error);
  ui["feedback-text"].textContent = message;
  ui.reconnect.hidden = !retry;
}

function controls() {
  const configuring = state.settingModel || window.piComposer.isChanging() || window.piContext.isCompacting() || state.attaching;
  const locked = state.loading || state.busy || configuring;
  ui["new-chat"].disabled = locked;
  ui.folder.disabled = locked;
  ui.model.disabled = locked || !state.connected;
  ui.attach.disabled = locked || state.attachments.length >= attachmentLimit;
  ui.send.disabled = state.stopping || !state.connected || state.loading || configuring ||
    (!state.busy && !ui.prompt.value.trim() && !state.attachments.length);
  const verb = state.busy ? "停止回复" : "发送";
  if (ui.send.title !== verb) {
    ui.send.title = verb;
    ui.send.setAttribute("aria-label", verb);
    drawIcon(ui.send, state.busy ? "stop" : "up", 18);
  }
  for (const row of ui.history.children) row.disabled = locked;
  window.piSettings.sync();
  window.piComposer.sync();
  window.piContext.sync();
}

function showFolder() {
  const folderKey = comparablePath(state.folder);
  const homeKey = comparablePath(state.home);
  const display = folderKey === homeKey ? "个人文件夹" : folderKey.startsWith(homeKey + "/")
    ? "~" + state.folder.slice(state.home.length) : state.folder;
  ui["folder-label"].textContent = display;
  ui.folder.title = state.folder;
  ui.folder.setAttribute("aria-label", "选择工作目录 " + display);
  window.piSettings.sync();
}

function showModel() {
  ui["model-label"].textContent = state.loading ? "正在连接…" : !state.connected ? "Pi 未连接" :
    state.model?.name || state.model?.id || "选择模型";
  ui.model.title = state.model ? state.model.provider + " / " + state.model.id : "";
  window.piSettings.sync();
  window.piComposer.sync();
}

function currentTitle() {
  return state.chats.find(chat => chat.path === state.sessionPath)?.title || "新对话";
}

function title(text) {
  ui["conversation-title"].textContent = text || "新对话";
  ui["conversation-title"].title = ui["conversation-title"].textContent;
}

async function refreshHistory() {
  const generation = state.generation;
  try {
    const chats = await host("history");
    if (generation !== state.generation) return;
    state.chats = chats;
    if (chats.some(chat => chat.path === state.sessionPath)) state.opened = state.sessionPath;
    ui.history.replaceChildren();
    for (const chat of chats) {
      const row = element("button", "history-row", chat.title);
      row.type = "button";
      row.title = chat.title + "\n" + chat.folder;
      if (chat.path === state.sessionPath) row.setAttribute("aria-current", "true");
      row.addEventListener("click", () => {
        if (chat.path !== state.sessionPath || !state.connected) openConversation(chat.folder, chat.path);
      });
      ui.history.append(row);
    }
    ui["history-empty"].hidden = chats.length > 0;
    ui["history-empty"].textContent = "暂无会话";
    controls();
  } catch {
    ui["history-empty"].hidden = false;
    ui["history-empty"].textContent = "暂时无法读取会话";
  }
}

function showTranscript() {
  ui.workspace.dataset.empty = "false";
  ui.welcome.hidden = true;
  ui.transcript.hidden = false;
}

function scrollIfFollowing(change) {
  const { scrollHeight, clientHeight, scrollTop } = ui.transcript;
  const following = scrollHeight - clientHeight - scrollTop < 80;
  change();
  if (following) ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

function addTurn(turn) {
  showTranscript();
  scrollIfFollowing(() => ui.messages.append(turn));
}

function showTool(id, name, args) {
  if (state.tools.has(id)) return state.tools.get(id);
  const details = element("details", "tool");
  const labels = { read: "读取文件", edit: "编辑文件", write: "写入文件", bash: "运行命令", grep: "搜索内容", find: "查找文件", ls: "查看目录" };
  const target = ((args?.path ?? args?.file_path ?? args?.command ?? args?.pattern) || "").toString().trim().split("\n")[0];
  const label = (labels[name] || name || "工具") + (target ? " / " + target.slice(0, 115) : "");
  const summary = element("summary", "", label);
  const output = element("pre", "", args ? JSON.stringify(args, null, 2) : "");
  details.append(summary, output);
  addTurn(details);
  const tool = { details, label, summary, output, args: output.textContent, path: args?.path ?? args?.file_path };
  state.tools.set(id, tool);
  return tool;
}

function toolFailureStatus(output) {
  if (output.includes("Cannot find module") && output.includes("/sandbox-worker.mjs")) return "失败（沙箱组件路径失效）";
  if (output.includes("com.apple.hiservices-xpcservice") && output.includes("Connection Invalid")) return "失败（系统自动化连接失败）";
  if (/沙箱拒绝了这次操作|Operation not permitted|Permission denied|\b(?:EACCES|EPERM)\b/i.test(output)) return "失败（权限受限）";
  const exitCode = output.match(/^Command exited with code (-?\d+)\s*$/m)?.[1];
  return exitCode ? "退出码 " + exitCode : "失败";
}

function toolResult(id, name, content, status) {
  const tool = showTool(id, name);
  const output = messageText(content);
  tool.details.dataset.status = status;
  const result = status === "error" ? toolFailureStatus(output) : status === "running" ? "运行中" : "已完成";
  tool.summary.textContent = tool.label + " · " + result;
  tool.output.textContent = (tool.args && output ? tool.args + "\n\n" : tool.args) + output;
  if (status === "done") window.piInspector.recordChange(name, tool.path);
}

function assistantTurn() {
  const node = element("article", "turn assistant");
  node.setAttribute("aria-label", "Pi 的回复");
  const answer = element("div", "answer");
  node.append(answer);
  return { node, answer, blocks: new Map() };
}

function paintAssistant(turn, text) {
  scrollIfFollowing(() => {
    turn.answer.replaceChildren();
    appendMarkdown(turn.answer, text);
  });
}

function appendMessage(message, turn = null) {
  if (!message) return;
  const { role, content } = message;
  const text = messageText(content);
  const blocks = Array.isArray(content) ? content : [];
  if (role === "user") {
    const node = element("article", "turn user");
    node.setAttribute("aria-label", "你的消息");
    for (const block of blocks) {
      const image = messageImage(block, "chat-image");
      if (image) node.append(image);
    }
    const { prompt, files } = messageAttachments(text);
    if (files.length) {
      const list = element("div", "chat-files");
      list.append(...files.map(file => attachmentChip(file)));
      node.append(list);
    }
    if (prompt) node.append(element("p", "bubble", prompt));
    if (node.childNodes.length) addTurn(node);
  } else if (role === "assistant" || (role === "custom" && message.display)) {
    if (text) {
      if (!turn) turn = assistantTurn();
      if (!turn.node.isConnected) addTurn(turn.node);
      paintAssistant(turn, text);
      if (role === "assistant") window.piInspector.recordLinks(text);
      const actions = element("div", "action-row");
      const copy = element("button", "icon-button copy-button");
      copy.type = "button";
      copy.title = "复制回复";
      copy.setAttribute("aria-label", "复制回复");
      copy.addEventListener("click", async () => {
        try {
          await host("copy", { text });
          drawIcon(copy, "check", 13);
          setTimeout(() => drawIcon(copy, "copy", 13), 900);
        } catch (error) { feedback(error.message, true); }
      });
      actions.append(copy);
      turn.node.append(actions);
      drawIcon(copy, "copy", 13);
    } else {
      turn?.node.remove();
    }
    for (const block of blocks) {
      if (block.type === "toolCall") showTool(block.id, block.name, block.arguments);
    }
  } else if (role === "toolResult") {
    toolResult(message.toolCallId, message.toolName, content, message.isError ? "error" : "done");
  }
}

async function loadMessages() {
  try {
    const { entries, leafId } = await rpc("get_entries");
    const byEntry = new Map(entries.map(entry => [entry.id, entry]));
    const branch = [];
    let entry = byEntry.get(leafId);
    while (entry && byEntry.delete(entry.id)) {
      if (entry.type === "message") branch.push(entry.message);
      entry = byEntry.get(entry.parentId);
    }
    return branch.reverse();
  } catch {
    return (await rpc("get_messages")).messages;
  }
}

async function openConversation(folder, session = null) {
  if (state.busy || state.settingModel || state.attaching || window.piComposer.isChanging() || window.piContext.isCompacting() || !folder) return;
  const generation = String(++state.nextRequest);
  state.generation = generation;
  state.loading = true;
  state.connected = false;
  state.opened = session;
  closeModelMenu();
  window.piComposer.reset();
  resetDialogs();
  controls();
  showModel();
  feedback();
  failRequests("Pi 正在切换会话。");
  try {
    const launch = await host("launch", { folder, session, generation });
    state.folder = folder;
    state.sessionDirectory = launch.sessionDirectory;
    showFolder();
    const details = await rpc("get_state", {}, 45000);
    await window.piComposer.connect(launch.permissionExtension, launch.nativeSandbox !== false);
    const messages = session ? await loadMessages() : [];
    state.connected = true;
    state.model = details.model;
    state.thinkingLevel = details.thinkingLevel;
    state.sessionPath = details.sessionFile;
    state.activeMessage = null;
    state.tools.clear();
    window.piInspector.reset(state.folder);
    ui.messages.replaceChildren();
    ui.workspace.dataset.empty = "true";
    ui.welcome.hidden = false;
    ui.transcript.hidden = true;
    for (const message of messages) appendMessage(message);
    title(details.sessionName || currentTitle());
    ui.transcript.scrollTop = ui.transcript.scrollHeight;
    await refreshHistory();
    title(details.sessionName || currentTitle());
  } catch (error) {
    if (ui.feedback.hidden) feedback(error.message || String(error), true, true);
  } finally {
    state.loading = false;
    showModel();
    controls();
    window.piContext.refresh();
    if (!window.piSettings.isOpen()) ui.prompt.focus();
  }
}

async function chooseFolder(onError = error => feedback(error.message, true)) {
  if (ui.folder.disabled) return;
  try {
    const path = await host("chooseFolder");
    if (path && path !== state.folder) await openConversation(path);
  } catch (error) { onError(error); }
}

function attachmentChip(attachment, removeAt = null) {
  const item = element("div", "attachment");
  const image = messageImage(attachment);
  const icon = image ?? element("span");
  if (!image) drawIcon(icon, "file", 15);
  const name = element("span", "button-label", attachment.name);
  item.title = attachment.name;
  item.append(icon, name);
  if (removeAt !== null) {
    const remove = element("button", "icon-button");
    remove.type = "button";
    remove.title = "移除 " + attachment.name;
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => {
      state.attachments.splice(removeAt, 1);
      renderAttachments();
    });
    item.append(remove);
    drawIcon(remove, "close", 12);
  }
  return item;
}

function renderAttachments() {
  ui.attachments.hidden = state.attachments.length === 0;
  ui.attachments.replaceChildren(...state.attachments.map((attachment, index) => attachmentChip(attachment, index)));
  controls();
}

function cannotSendImages() {
  return Array.isArray(state.model?.input) && !state.model.input.includes("image");
}

async function attach() {
  if (ui.attach.disabled) return;
  state.attaching = true;
  controls();
  try {
    const selection = await host("chooseAttachments", { limit: attachmentLimit - state.attachments.length });
    if (!selection) return;
    state.attachments.push(...selection.attachments);
    const text = selection.errors.join(" · ");
    const imageHint = selection.attachments.some(item => item.type === "image") && cannotSendImages() ? imageModelMessage : "";
    feedback([text, imageHint].filter(Boolean).join(" · "), Boolean(text));
  } catch (error) { feedback(error.message, true); }
  finally {
    state.attaching = false;
    renderAttachments();
    ui.prompt.focus();
  }
}

function resizePrompt() {
  ui.prompt.style.height = "0";
  ui.prompt.style.height = Math.min(ui.prompt.scrollHeight + 2, 195) + "px";
  controls();
}

async function send() {
  if (ui.send.disabled) return;
  if (state.busy) {
    state.stopping = true;
    controls();
    feedback("正在停止…");
    try {
      await rpc("abort");
      if (state.busy) await settled(true);
    } catch (error) { feedback(error.message, true); }
    finally { state.stopping = false; controls(); }
    return;
  }
  const draft = ui.prompt.value;
  const attachments = state.attachments;
  const images = attachments.filter(item => item.type === "image");
  if (images.length && cannotSendImages()) {
    feedback(imageModelMessage, true);
    return;
  }
  const text = attachedPrompt(draft.trim(), attachments) || "请查看图片。";
  state.busy = true;
  state.attachments = [];
  ui.prompt.value = "";
  resizePrompt();
  renderAttachments();
  closeModelMenu();
  window.piComposer.close();
  feedback("Pi 正在回复…");
  try {
    const result = await rpc("prompt", { message: text,
      ...(images.length ? { images: images.map(({ type, data, mimeType }) => ({ type, data, mimeType })) } : {}) },
      90000);
    if (result?.disposition === "handled" && !state.activeMessage) await settled();
  } catch (error) {
    state.busy = false;
    if (!ui.prompt.value) ui.prompt.value = draft;
    state.attachments = attachments;
    renderAttachments();
    resizePrompt();
    feedback(error.message, true, !state.connected);
  }
}

async function settled(aborted = false) {
  state.busy = false;
  state.stopping = false;
  controls();
  window.piContext.refresh();
  if (ui.feedback.dataset.error !== "true") feedback(aborted ? "已停止回复" : "");
  const generation = state.generation;
  try {
    const details = await rpc("get_state");
    if (state.generation !== generation) return;
    state.sessionPath = details.sessionFile;
    state.model = details.model;
    state.thinkingLevel = details.thinkingLevel;
    showModel();
    await refreshHistory();
    if (state.generation === generation && !state.busy) title(details.sessionName || currentTitle());
  } catch {
    // Disconnection is shown by the process exit handler.
  }
}

async function selectModel(model) {
  if (state.settingModel || window.piComposer.isChanging()) return false;
  state.settingModel = true;
  controls();
  const generation = state.generation;
  try {
    const chosen = await rpc("set_model", { provider: model.provider, modelId: model.id });
    if (state.generation !== generation) return false;
    state.model = chosen;
    showModel();
    window.piContext.refresh();
    return true;
  } finally {
    state.settingModel = false;
    controls();
  }
}

async function availableThinkingLevels() {
  return (await rpc("get_available_thinking_levels")).levels;
}

async function selectThinkingLevel(level) {
  const generation = state.generation;
  await rpc("set_thinking_level", { level });
  const details = await rpc("get_state");
  if (state.generation === generation) {
    state.thinkingLevel = details.thinkingLevel;
    window.piSettings.sync();
    window.piComposer.sync();
  }
}

function renderModels() {
  const query = ui["model-filter"].value.trim().toLowerCase();
  const matches = state.models.filter(model => [model.name, model.provider, model.id,
    model.input?.includes("image") ? "支持图片" : ""].some(value => value?.toLowerCase().includes(query)));
  ui["model-options"].replaceChildren();
  if (!matches.length) {
    ui["model-options"].append(element("span", "model-empty", query ? "没有匹配的模型" : "Pi 没有返回可用模型"));
  }
  for (const model of matches) {
    const row = element("button", "model-option", model.name || model.id);
    row.type = "button";
    row.append(element("small", "", model.provider + (model.input?.includes("image") ? " · 支持图片" : "")));
    row.setAttribute("aria-pressed", String(model.id === state.model?.id && model.provider === state.model?.provider));
    row.addEventListener("click", async () => {
      row.disabled = true;
      try {
        if (!await selectModel(model)) return;
        closeModelMenu();
        ui.prompt.focus();
      } catch (error) { feedback(error.message, true); }
      finally { row.disabled = false; }
    });
    ui["model-options"].append(row);
  }
}

function closeModelMenu() {
  ui["model-menu"].hidden = true;
  ui.model.setAttribute("aria-expanded", "false");
}

async function toggleModelMenu() {
  if (!ui["model-menu"].hidden) { closeModelMenu(); return; }
  window.piComposer.close();
  ui["model-menu"].hidden = false;
  ui.model.setAttribute("aria-expanded", "true");
  ui["model-filter"].value = "";
  ui["model-options"].replaceChildren(element("span", "model-empty", "正在读取模型…"));
  ui["model-filter"].focus();
  const generation = state.generation;
  try {
    const data = await rpc("get_available_models");
    if (generation !== state.generation || ui["model-menu"].hidden) return;
    state.models = data.models;
    renderModels();
  } catch (error) {
    if (!ui["model-menu"].hidden) ui["model-options"].replaceChildren(element("span", "model-empty", error.message));
  }
}

const dialog = ui["extension-dialog"];
let activeDialog;

function resetDialogs() {
  clearTimeout(activeDialog?.timer);
  activeDialog = null;
  state.dialogs = [];
  if (dialog.open) dialog.close("cancel");
}

function nextDialog() {
  if (dialog.open || !state.dialogs.length) return;
  const request = state.dialogs.shift();
  if (request.deadline && request.deadline <= Date.now()) { nextDialog(); return; }
  activeDialog = request;
  ui["dialog-title"].textContent = request.title || "Pi";
  ui["dialog-text"].textContent = request.message || "";
  ui["dialog-text"].hidden = !request.message;
  ui["dialog-options"].replaceChildren();
  const permission = request.method === "confirm" && request.title === "允许工具执行？";
  dialog.querySelector('button[value="cancel"]').textContent = permission ? "拒绝" : "取消";
  dialog.querySelector('button[value="ok"]').textContent = permission ? "允许" : "确定";
  let field;
  if (request.method === "select") {
    field = element("select");
    for (const choice of request.options || []) field.append(element("option", "", choice));
  } else if (request.method === "input" || request.method === "editor") {
    field = element(request.method === "input" ? "input" : "textarea");
    field.placeholder = request.placeholder || "";
    field.value = request.prefill || "";
  }
  if (field) {
    field.setAttribute("aria-label", request.title);
    ui["dialog-options"].append(field);
  }
  dialog.returnValue = "cancel";
  dialog.showModal();
  if (request.deadline) request.timer = setTimeout(() => dialog.close("cancel"), request.deadline - Date.now());
}

dialog.addEventListener("close", () => {
  if (!activeDialog) return;
  const request = activeDialog;
  activeDialog = null;
  clearTimeout(request.timer);
  const value = ui["dialog-options"].firstElementChild?.value;
  const answer = dialog.returnValue !== "ok" ? { cancelled: true } : request.method === "confirm" ? { confirmed: true } : { value };
  host("rpc", { record: { type: "extension_ui_response", id: request.id, ...answer } }).catch(error => feedback(error.message, true));
  nextDialog();
});

function extensionEvent(event) {
  if (["select", "confirm", "input", "editor"].includes(event.method)) {
    state.dialogs.push({ ...event, deadline: event.timeout ? Date.now() + event.timeout : null });
    nextDialog();
  } else if (event.method === "notify") {
    feedback(event.message, event.notifyType === "error" || event.notifyType === "warning");
  } else if (event.method === "set_editor_text") {
    ui.prompt.value = event.text || "";
    resizePrompt();
  } else if (event.method === "setStatus") {
    window.piComposer.handleStatus(event);
    window.piContext.handleStatus(event);
  }
}

function handleEvent(event) {
  switch (event.type) {
    case "response": {
      const reply = state.pending.get(event.id);
      state.pending.delete(event.id);
      reply?.(event.success ? null : event.error || "Pi 无法执行指令。", event.data);
      break;
    }
    case "extension_ui_request": extensionEvent(event); break;
    case "agent_start":
      state.busy = true;
      controls();
      feedback("Pi 正在回复…");
      break;
    case "agent_settled": settled(event.aborted); break;
    case "turn_end":
    case "compaction_end":
      window.piContext.refresh();
      break;
    case "auto_retry_start": feedback("Pi 正在重试…"); break;
    case "message_start":
      if (event.message.role === "assistant") state.activeMessage = assistantTurn();
      break;
    case "message_update": {
      const change = event.assistantMessageEvent;
      if (!change || !["text_delta", "text_end"].includes(change.type)) break;
      const turn = state.activeMessage || (state.activeMessage = assistantTurn());
      const prev = turn.blocks.get(change.contentIndex) || "";
      turn.blocks.set(change.contentIndex, change.type === "text_end" ? change.content : prev + change.delta);
      if (!turn.frame) {
        turn.frame = requestAnimationFrame(() => {
          turn.frame = null;
          const text = [...turn.blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block).join("\n\n");
          if (!turn.node.isConnected) addTurn(turn.node);
          paintAssistant(turn, text);
        });
      }
      break;
    }
    case "message_end": {
      const message = event.message;
      if (message.role === "assistant") {
        const turn = state.activeMessage;
        if (turn?.frame) cancelAnimationFrame(turn.frame);
        state.activeMessage = null;
        if (message.stopReason === "error") feedback(message.errorMessage || "Pi 的模型请求失败。", true);
        appendMessage(message, turn);
      } else {
        appendMessage(message);
        if (message.role === "user") {
          window.piContext.refresh();
          if (ui["conversation-title"].textContent === "新对话") {
            title(messageAttachments(messageText(message.content)).prompt.replace(/\s+/g, " ").trim().slice(0, 100));
          }
        }
      }
      break;
    }
    case "tool_execution_start": showTool(event.toolCallId, event.toolName, event.args); break;
    case "tool_execution_update": toolResult(event.toolCallId, event.toolName, event.partialResult?.content, "running"); break;
    case "tool_execution_end":
      toolResult(event.toolCallId, event.toolName, event.result?.content, event.isError ? "error" : "done");
      break;
    case "thinking_level_changed":
      state.thinkingLevel = event.level;
      window.piSettings.sync();
      window.piComposer.sync();
      break;
    case "session_info_changed": title(event.name || currentTitle()); break;
  }
}

window.piDesktop = {
  receive({ generation, records }) {
    if (generation !== state.generation) return;
    for (const record of records) {
      try { handleEvent(JSON.parse(record)); }
      catch (error) { console.error("无法处理 Pi 的事件", error.message); }
    }
  },
  disconnected({ generation, status, detail }) {
    if (generation !== state.generation) return;
    state.connected = false;
    state.busy = false;
    state.stopping = false;
    resetDialogs();
    closeModelMenu();
    window.piComposer.reset();
    failRequests("Pi 已断开连接。");
    feedback(detail.slice(-600) || "Pi 已退出（" + status + "）。", true, true);
    showModel();
    controls();
  },
  menu({ action }) {
    if (action === "settings") { window.piSettings.open(); return; }
    if (ui["new-chat"].disabled || window.piSettings.isOpen()) return;
    if (action === "newSession") openConversation(state.folder);
    if (action === "chooseFolder") chooseFolder();
  }
};

window.piWin?.receive((name, data) => window.piDesktop[name]?.(data));
if (windowsDesktop) {
  document.documentElement.dataset.platform = "windows";
  for (const key of document.querySelectorAll("kbd")) key.textContent = key.textContent.replace("⌘", "Ctrl+");
  document.getElementById("modifier-enter-label").textContent = "Ctrl + 回车";
}

function sidebar(show, focus = true) {
  ui.layout.classList.toggle("sidebar-collapsed", !show);
  ui["hide-sidebar"].hidden = !show;
  ui["show-sidebar"].hidden = show;
  ui["open-settings-collapsed"].hidden = show;
  if (focus) ui[show ? "hide-sidebar" : "show-sidebar"].focus();
}

for (const icon of document.querySelectorAll("[data-icon]")) {
  drawIcon(icon, icon.dataset.icon, icon === ui.send ? 18 : icon.dataset.icon === "chevron" ? 12 : 16);
}
ui["hide-sidebar"].addEventListener("click", () => sidebar(false));
ui["show-sidebar"].addEventListener("click", () => sidebar(true));
ui["new-chat"].addEventListener("click", () => openConversation(state.folder));
ui.folder.addEventListener("click", () => chooseFolder());
ui.attach.addEventListener("click", attach);
ui.model.addEventListener("click", toggleModelMenu);
ui["model-filter"].addEventListener("input", renderModels);
ui.reconnect.addEventListener("click", () => openConversation(state.folder, state.opened));
ui.prompt.addEventListener("input", resizePrompt);
ui.prompt.addEventListener("keydown", event => {
  const modifier = windowsDesktop ? event.ctrlKey : event.metaKey;
  const shortcut = (window.piSettings.sendsOnEnter() ? !modifier : modifier) && (windowsDesktop ? !event.metaKey : !event.ctrlKey);
  if (event.key === "Enter" && shortcut && !event.shiftKey && !event.altKey &&
      !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!state.busy) send();
  }
});
ui.composer.addEventListener("submit", event => { event.preventDefault(); send(); });
document.addEventListener("pointerdown", event => {
  if (!event.target.closest(".model-picker")) closeModelMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !ui["model-menu"].hidden) {
    closeModelMenu();
    ui.model.focus();
  }
});

(async () => {
  try {
    const initial = await host("initial");
    state.home = initial.home;
    state.folder = initial.folder;
    state.sessionDirectory = initial.sessionDirectory;
    window.piSettings.load(initial.preferences);
    sidebar(window.piSettings.showSidebarOnLaunch(), false);
    showFolder();
    await openConversation(state.folder);
  } catch (error) {
    state.loading = false;
    controls();
    showModel();
    feedback(error.message || String(error), true, true);
  }
})();
