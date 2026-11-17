"use strict";

(() => {
  const command = "pi-desktop-context-details";
  const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
  const value = id => document.getElementById(id);
  const short = tokens => tokens >= 1e6 ? number.format(tokens / 1e6) + "M" :
    tokens >= 1e3 ? number.format(tokens / 1e3) + "k" : number.format(tokens);
  const percent = fraction => fraction > 0 && fraction < .1 ? "<0.1%" : number.format(fraction) + "%";
  let version = 0;
  let timer;
  let supported = false;
  let usage = null;
  let detail = null;
  let compacting = false;

  function breakdown(capacity, used) {
    const rows = [
      ["messages", "消息及其他", null],
      ["mcp", "MCP 工具", detail?.mcp?.reduce((sum, item) => sum + item.tokens, 0)],
      ["tools", "系统工具", detail?.systemTools],
      ["prompt", "系统提示", detail?.systemPrompt],
      ["skills", "技能", detail?.skills],
      ["instructions", "MCP 服务说明", detail?.mcpInstructions],
      ["memory", "记忆与项目文件", detail?.memory]
    ];
    const known = rows.reduce((sum, row) => sum + (row[2] ?? 0), 0);
    // Keep the estimates within Pi's overall window total when tokenizer counts differ.
    if (used !== null) {
      const scale = known > used ? used / known : 1;
      for (const row of rows) if (row[2] != null) row[2] = Math.floor(row[2] * scale);
      rows[0][2] = Math.max(0, used - rows.reduce((sum, row) => sum + (row[2] ?? 0), 0));
    }
    const remaining = used === null ? null : Math.max(0, capacity - used);
    const buffer = remaining === null || !Number.isFinite(detail?.reserve) || !detail.autoCompaction
      ? null : Math.min(detail.reserve, remaining);
    if (detail?.autoCompaction) rows.push(["buffer", "自动压缩预留", buffer]);
    rows.push(["free", "剩余空间", remaining === null ? null : remaining - (buffer ?? 0)]);
    return rows;
  }

  function group(title, items, fileNames = false) {
    if (!items?.length) return null;
    const wrapper = element("details", "context-group");
    const count = items.reduce((sum, item) => sum + (item.count ?? 1), 0);
    wrapper.append(element("summary", "", `${title} · ${count}`));
    for (const item of items) {
      const row = element("div", "context-group-row");
      const name = element("span", "button-label", fileNames ? item.name.split("/").at(-1) : item.name);
      name.title = item.name;
      row.append(name, element("span", "", short(item.tokens)));
      wrapper.append(row);
    }
    return wrapper;
  }

  function renderPanel(prefix, data, capacity, used) {
    const table = value(prefix + "-rows");
    const bar = value(prefix === "context" ? "context-detail-bar" : prefix + "-bar");
    const groups = value(prefix + "-groups");
    const openGroups = Array.from(groups.querySelectorAll("details"), node => node.open);
    table.replaceChildren();
    bar.replaceChildren();
    for (const [kind, label, tokens] of data) {
      const row = element("div", "context-row");
      const dot = element("span", "context-dot");
      dot.dataset.kind = kind;
      dot.setAttribute("aria-hidden", "true");
      const name = element("dt");
      name.append(dot, element("span", "", label));
      row.append(name, element("dd", "context-count", tokens == null ? "—" : short(tokens)),
        element("dd", "context-fraction", tokens == null || !capacity ? "—" : percent(tokens / capacity * 100)));
      table.append(row);
      if (used !== null && tokens > 0 && capacity) {
        const segment = element("span", "context-segment");
        segment.dataset.kind = kind;
        segment.style.flexBasis = Math.min(100, tokens / capacity * 100) + "%";
        segment.title = label + " " + percent(tokens / capacity * 100);
        bar.append(segment);
      }
    }
    const items = [group("MCP 工具", detail?.mcp), group("记忆与项目文件", detail?.files, true)].filter(Boolean);
    items.forEach((item, index) => { item.open = openGroups[index] ?? false; });
    groups.replaceChildren(...items);
  }

  function render() {
    const capacity = usage?.contextWindow > 0 ? usage.contextWindow : null;
    const used = capacity && Number.isFinite(usage.tokens) ? Math.max(0, usage.tokens) : null;
    const fraction = used === null ? 0 : used / capacity * 100;
    const label = used === null ? "—" : percent(fraction);
    value("context-fill").style.width = Math.min(100, fraction) + "%";
    value("context-fill").dataset.nearLimit = String(fraction >= 90);
    value("context-percent").textContent = label;
    value("context-total").textContent = used === null ? (capacity ? short(capacity) : "—") :
      `${short(used)} / ${short(capacity)} (${label})`;
    value("inspector-context-percent").textContent = used === null ? "—" : label + " 已用";
    const button = value("context-usage");
    const accessible = used === null ? "上下文用量待更新" : `上下文用量 ${label}，${number.format(used)} / ${number.format(capacity)} tokens`;
    button.title = accessible;
    button.setAttribute("aria-label", accessible);
    let note = "等待 Pi 更新上下文用量";
    if (used !== null) {
      note = detail?.autoCompaction && Number.isFinite(detail.reserve)
        ? `距自动压缩 ${short(Math.max(0, capacity - detail.reserve - used))}` : "";
    }
    value("context-message").textContent = note;
    const rows = breakdown(capacity, used);
    renderPanel("context", rows, capacity, used);
    renderPanel("inspector-context", rows, capacity, used);
  }

  function sync() {
    value("compact-session").disabled = compacting || !state.connected || state.loading || state.busy ||
      state.settingModel || state.attaching || window.piComposer.isChanging() ||
      ui.workspace.dataset.empty === "true" || usage?.tokens == null;
  }

  function reset() {
    clearTimeout(timer);
    version++;
    supported = false;
    usage = null;
    detail = null;
    render();
  }

  function refresh() {
    if (!state.connected) return;
    clearTimeout(timer);
    const request = ++version;
    timer = setTimeout(async () => {
      try {
        const stats = await rpc("get_session_stats");
        if (request !== version) return;
        usage = stats.contextUsage;
        render();
        sync();
        if (supported && !state.busy && !state.loading && !state.settingModel && !compacting) {
          await rpc("prompt", { message: `/${command} ${request}` }, 8000);
        }
      } catch (error) {
        if (request === version) console.warn("Pi context refresh", error.message);
      }
    }, 160);
  }

  function handleStatus(event) {
    if (supported && event.statusKey === command) {
      try {
        const next = JSON.parse(event.statusText);
        if (next.request !== version) return;
        detail = next;
        render();
      } catch { /* A malformed extension status is not context data. */ }
    }
  }

  value("show-context-details").addEventListener("click", () => {
    window.piComposer.close();
    window.piInspector.show(true, true);
    refresh();
  });
  value("compact-session").addEventListener("click", async () => {
    compacting = true;
    controls();
    feedback("Pi 正在压缩会话…");
    try {
      await rpc("compact", {}, 180000);
      feedback("会话已压缩");
    } catch (error) { feedback(error.message, true); }
    finally { compacting = false; controls(); refresh(); }
  });

  render();
  window.piContext = { command, reset, refresh, sync, handleStatus, connect: value => { supported = value; }, isCompacting: () => compacting };
})();
