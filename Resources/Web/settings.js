"use strict";

(() => {
  const dialog = document.getElementById("settings");
  const search = document.getElementById("settings-search");
  const content = document.getElementById("settings-content");
  const feedback = document.getElementById("settings-feedback");
  const categories = [...dialog.querySelectorAll("[data-settings-page]")];
  const panels = [...dialog.querySelectorAll("[data-settings-panel]")];
  const formFields = [...dialog.querySelectorAll("[data-preference]")];
  const modelPanel = dialog.querySelector('[data-settings-panel="model"]');
  const modelField = document.getElementById("settings-model");
  const thinkingField = document.getElementById("settings-thinking");
  const engineStatus = document.getElementById("settings-engine-status");
  const folderButton = document.getElementById("settings-folder");
  const folderPath = document.getElementById("settings-folder-path");
  const sessionPath = document.getElementById("settings-session-path");
  const sessionButton = document.getElementById("settings-reveal");
  const levels = window.piComposer.thinkingLabels;
  const preferences = {};
  let category = "general";
  let opener;
  let engine;
  let savingEngine = false;

  function report(error) {
    feedback.textContent = error?.message || error || "";
    feedback.hidden = !feedback.textContent;
  }

  function load(snapshot) {
    Object.assign(preferences, snapshot);
    const root = document.documentElement;
    root.dataset.chatWidth = preferences.chatWidth ?? "standard";
    root.dataset.replyFont = preferences.replyFont ?? "serif";
    root.dataset.codeSize = preferences.codeSize ?? "12";
    document.getElementById("prompt-shortcut").textContent = preferences.sendShortcut === "command-enter"
      ? (windowsDesktop ? "Ctrl" : "Command") + " 加回车发送，回车换行。" : "回车发送，Shift 加回车换行。";
    for (const field of formFields) {
      const value = preferences[field.dataset.preference];
      if (value === undefined) continue;
      if (field.type === "radio") field.checked = field.value === value;
      else if (field.type === "checkbox") field.checked = value === "show";
      else field.value = value;
    }
  }

  async function savePreference(field) {
    const key = field.dataset.preference;
    const related = formFields.filter(input => input.dataset.preference === key);
    const value = field.type === "checkbox" ? (field.checked ? "show" : "hide") : field.value;
    for (const input of related) input.disabled = true;
    report();
    try {
      await host("setDesktopPreference", { key, value });
      load({ [key]: value });
    } catch (error) {
      load({});
      report(error);
    } finally {
      for (const input of related) input.disabled = false;
    }
  }

  function selectPanel() {
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filter = terms.length > 0;
    let results = 0;
    for (const panel of panels) {
      const rows = [...panel.querySelectorAll("[data-setting]")];
      const heading = panel.querySelector("h3").textContent;
      for (const row of rows) {
        const text = (heading + " " + row.firstElementChild.textContent).toLowerCase();
        row.hidden = filter && !terms.every(term => text.includes(term));
        if (!row.hidden) results++;
      }
      panel.hidden = filter ? rows.every(row => row.hidden) : panel.dataset.settingsPanel !== category;
    }
    for (const button of categories) {
      if (!filter && button.dataset.settingsPage === category) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    document.getElementById("settings-no-results").hidden = !filter || results > 0;
    content.scrollTop = 0;
    sync();
  }

  function modelKey(model) {
    return model ? JSON.stringify([model.provider, model.id]) : "";
  }

  function makeOption(label, value) {
    const option = document.createElement("option");
    option.textContent = label;
    option.value = value;
    return option;
  }

  function modelPlaceholder(field, text) {
    field.replaceChildren(makeOption(text, ""));
  }

  async function loadEngine(key) {
    const request = { key, loading: true, models: [], levels: [], error: "" };
    engine = request;
    modelPlaceholder(modelField, "正在读取…");
    modelPlaceholder(thinkingField, "正在读取…");
    const [models, thinking] = await Promise.allSettled([rpc("get_available_models"), availableThinkingLevels()]);
    if (engine !== request || !dialog.open) return;
    request.loading = false;
    request.models = models.value?.models ?? [];
    request.levels = thinking.value ?? [];
    request.error = models.reason?.message || thinking.reason?.message || "";

    const placeholder = makeOption(request.models.length ? "选择模型" : "没有可用模型", "");
    placeholder.disabled = true;
    const choices = request.models.map(model => makeOption((model.name || model.id) + " · " + model.provider, modelKey(model)));
    const selected = modelKey(state.model);
    if (state.model && !choices.some(option => option.value === selected)) {
      const current = makeOption(state.model.name || state.model.id, selected);
      current.disabled = true;
      choices.unshift(current);
    }
    modelField.replaceChildren(placeholder, ...choices);
    modelField.value = selected;
    thinkingField.replaceChildren(...request.levels.map(level => makeOption(levels[level] || level, level)));
    if (!request.levels.length) modelPlaceholder(thinkingField, "不可用");
    sync();
  }

  function sync() {
    if (!dialog.open) return;
    folderPath.textContent = state.folder || "正在读取…";
    sessionPath.textContent = state.sessionDirectory || "正在读取…";
    folderButton.disabled = state.loading || state.busy || savingEngine;
    sessionButton.disabled = state.loading || !state.sessionDirectory;
    if (modelPanel.hidden) return;

    const available = state.connected && !state.loading && !state.busy;
    const key = state.generation + modelKey(state.model);
    if (available && !savingEngine && engine?.key !== key) void loadEngine(key);
    if (!available && !state.connected && !state.loading) {
      modelPlaceholder(modelField, "未连接");
      modelPlaceholder(thinkingField, "未连接");
      engine = null;
    }
    const ready = available && !savingEngine && engine?.key === key && !engine.loading;
    modelField.disabled = !ready || !engine.models.length;
    thinkingField.disabled = !ready || engine.levels.length < 2;
    if (ready) {
      modelField.value = modelKey(state.model);
      if (engine.levels.includes(state.thinkingLevel)) thinkingField.value = state.thinkingLevel;
    }
    engineStatus.textContent = state.loading ? "正在连接 Pi…" : !state.connected ? "连接 Pi 后可设置当前会话的模型。" :
      state.busy ? "Pi 正在回复，结束后可修改。" : engine?.error || "";
    engineStatus.hidden = !engineStatus.textContent;
  }

  async function changeEngine(change) {
    if (savingEngine) return;
    savingEngine = true;
    report();
    sync();
    try {
      await change();
    } catch (error) {
      report(error);
    } finally {
      savingEngine = false;
      sync();
    }
  }

  function open() {
    if (dialog.open || document.getElementById("extension-dialog").open) return;
    opener = document.activeElement;
    closeModelMenu();
    window.piComposer.close();
    search.value = "";
    report();
    dialog.showModal();
    selectPanel();
  }

  document.getElementById("open-settings").addEventListener("click", open);
  document.getElementById("open-settings-collapsed").addEventListener("click", open);
  document.getElementById("settings-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    engine = null;
    if (opener && opener !== document.body && opener.getClientRects().length) opener.focus();
    else document.getElementById("prompt").focus();
  });
  search.addEventListener("input", selectPanel);
  for (const button of categories) {
    button.addEventListener("click", () => {
      category = button.dataset.settingsPage;
      search.value = "";
      report();
      selectPanel();
    });
  }
  for (const field of formFields) field.addEventListener("change", () => savePreference(field));
  modelField.addEventListener("change", () => {
    const model = engine?.models.find(entry => modelKey(entry) === modelField.value);
    if (model) changeEngine(() => selectModel(model));
  });
  thinkingField.addEventListener("change", () => {
    const level = thinkingField.value;
    if (!engine?.levels.includes(level)) return;
    changeEngine(() => selectThinkingLevel(level));
  });
  folderButton.addEventListener("click", () => { report(); chooseFolder(report); });
  sessionButton.addEventListener("click", () => { report(); host("revealSessions").catch(report); });

  window.piSettings = {
    open, load, sync,
    isOpen: () => dialog.open,
    showSidebarOnLaunch: () => preferences.sidebarOnLaunch !== "hide",
    sendsOnEnter: () => preferences.sendShortcut !== "command-enter"
  };
})();
