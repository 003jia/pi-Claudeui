"use strict";

(() => {
  const modes = {
    auto: ["自动", "内置工具在 macOS 沙箱内自动执行。项目目录可写，网络受限。"],
    manual: ["手动", "执行文件改动、命令或其他工具前请你确认。"],
    "accept-edits": ["接受编辑", "自动接受文件编辑和写入，命令等其他操作仍需确认。"],
    plan: ["计划", "只读分析并拟定计划，切换模式后再执行。"],
    bypass: ["跳过确认", "直接执行已启用的工具。"]
  };
  const levels = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };
  const modeCommand = "pi-desktop-tool-mode";
  const buttonIds = { thinking: "thinking-depth", mode: "tool-mode", context: "context-usage" };
  const fields = Object.fromEntries([
    ...Object.values(buttonIds), "thinking-label", "thinking-menu", "thinking-options", "tool-mode-label", "mode-menu",
    "mode-options", "context-menu"
  ].map(id => [id, document.getElementById(id)]));
  let openMenu = null;
  let selectedMode = null;
  let modeAvailable = false;
  let changing = false;

  function sync() {
    const unavailable = !state.connected || state.loading || state.busy || state.settingModel || changing || window.piContext.isCompacting();
    const thinking = state.connected && state.model ? levels[state.thinkingLevel] || state.thinkingLevel || "关闭" : "—";
    const mode = modes[selectedMode]?.[0] ?? "—";
    fields["thinking-label"].textContent = "深度 " + thinking;
    fields["thinking-depth"].setAttribute("aria-label", "思考深度 " + thinking);
    fields["thinking-depth"].disabled = unavailable || !state.model;
    fields["tool-mode-label"].textContent = mode === "—" ? "模式 —" : mode;
    fields["tool-mode"].setAttribute("aria-label", "权限模式 " + mode);
    fields["tool-mode"].disabled = unavailable || !modeAvailable;
  }

  function reset() {
    close();
    selectedMode = null;
    modeAvailable = false;
    window.piContext.reset();
  }

  async function applyMode(mode) {
    const response = await rpc("prompt", { message: "/" + modeCommand + " " + mode }, 12000);
    if (response?.disposition !== "handled" || selectedMode !== mode) throw new Error("Pi 未应用该权限模式。");
  }

  async function connect(path) {
    const { commands } = await rpc("get_commands");
    const supports = name => commands.some(command =>
      command.name === name && command.source === "extension" && command.sourceInfo?.path === path);
    modeAvailable = supports(modeCommand);
    window.piContext.connect(supports(window.piContext.command));
    if (!modeAvailable) throw new Error("Pi 未加载桌面权限模式。");
    await applyMode("auto");
  }

  function handleStatus(event) {
    if (event.method !== "setStatus" || event.statusKey !== modeCommand || !Object.hasOwn(modes, event.statusText)) return;
    selectedMode = event.statusText;
    sync();
  }

  function close(restoreFocus = false) {
    if (!openMenu) return;
    const button = fields[buttonIds[openMenu]];
    fields[openMenu + "-menu"].hidden = true;
    button.setAttribute("aria-expanded", "false");
    openMenu = null;
    if (restoreFocus) button.focus();
  }

  async function change(action) {
    if (changing || state.busy || state.loading || !state.connected || window.piContext.isCompacting()) return;
    changing = true;
    close();
    controls();
    try {
      await action();
    } catch (error) {
      feedback(error.message, true);
    } finally {
      changing = false;
      controls();
      if (!window.piSettings.isOpen()) ui.prompt.focus();
    }
  }

  function choice(label, description, selected, action) {
    const button = element("button", "composer-choice");
    button.type = "button";
    button.setAttribute("aria-pressed", String(selected));
    const copy = element("span", "", label);
    if (description) copy.append(element("small", "", description));
    button.append(copy);
    if (selected) {
      const check = element("span", "selection-mark");
      check.setAttribute("aria-hidden", "true");
      button.append(check);
      drawIcon(check, "check", 15);
    }
    button.addEventListener("click", action);
    return button;
  }

  function showModes() {
    fields["mode-options"].replaceChildren(...Object.entries(modes).map(([mode, [label, description]]) =>
      choice(label, mode === "auto" && state.folder === state.home
        ? "内置工具在 macOS 沙箱内自动执行。个人文件夹只读，选择项目后可写。"
        : description, mode === selectedMode, () => {
        if (mode === selectedMode) close(true);
        else void change(() => applyMode(mode));
      })));
  }

  async function showThinking() {
    const list = fields["thinking-options"];
    list.replaceChildren(element("p", "composer-option-message", "正在读取…"));
    const generation = state.generation;
    const provider = state.model?.provider;
    const modelId = state.model?.id;
    try {
      const choices = await availableThinkingLevels();
      if (openMenu !== "thinking" || generation !== state.generation ||
          provider !== state.model?.provider || modelId !== state.model?.id) return;
      list.replaceChildren(...choices.map(level =>
        choice(levels[level] || level, "", level === state.thinkingLevel, () => {
          if (level === state.thinkingLevel) close(true);
          else void change(() => selectThinkingLevel(level));
        })));
      if (!choices.length) list.append(element("p", "composer-option-message", "当前模型没有可选级别。"));
    } catch (error) {
      if (openMenu === "thinking") list.replaceChildren(element("p", "composer-option-message", error.message));
    }
  }

  function toggle(menu) {
    if (openMenu === menu) { close(true); return; }
    close();
    closeModelMenu();
    openMenu = menu;
    fields[menu + "-menu"].hidden = false;
    fields[buttonIds[menu]].setAttribute("aria-expanded", "true");
    if (menu === "mode") showModes();
    if (menu === "thinking") void showThinking();
    if (menu === "context") window.piContext.refresh();
  }

  for (const [menu, id] of Object.entries(buttonIds)) fields[id].addEventListener("click", () => toggle(menu));
  document.addEventListener("pointerdown", event => {
    if (openMenu && !fields[buttonIds[openMenu]].parentElement.contains(event.target)) close();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && openMenu) close(true);
  });

  window.piComposer = { connect, close, handleStatus, reset, sync, isChanging: () => changing, thinkingLabels: levels };
})();
