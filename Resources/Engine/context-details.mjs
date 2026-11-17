export const contextCommand = "pi-desktop-context-details";

// Pi reports the window total. Its providers do not return per-category token counts.
const estimate = text => Math.ceil((text?.length ?? 0) / 4);

function toolEstimate({ name, description, parameters }) {
  return estimate(JSON.stringify({ name, description, input_schema: parameters }));
}

export function registerContextDetails(pi, defaultCompaction) {
  pi.registerCommand(contextCommand, {
    description: "Return Pi Desktop context window estimates",
    handler: async (requested, ctx) => {
      const request = Number(requested.trim());
      if (!ctx.isIdle() || !Number.isSafeInteger(request)) return;
      const options = ctx.getSystemPromptOptions();
      const active = new Set(pi.getActiveTools());
      const hidden = new Set(options.hiddenTools);
      const groups = new Map();
      let systemTools = 0;
      for (const tool of pi.getAllTools()) {
        if (!active.has(tool.name) || hidden.has(tool.name)) continue;
        const tokens = toolEstimate(tool);
        const mcp = /^mcp__(.+?)__/.exec(tool.name);
        if (mcp) {
          const name = mcp[1];
          const group = groups.get(name) ?? { name, tokens: 0, count: 0 };
          group.tokens += tokens;
          group.count++;
          groups.set(name, group);
        } else {
          systemTools += tokens;
        }
      }

      let prompt = ctx.getSystemPrompt();
      function takeSection(name) {
        const pattern = new RegExp(`^<${name}>\\n[\\s\\S]*?^</${name}>`, "m");
        const part = prompt.match(pattern)?.[0];
        if (part) prompt = prompt.replace(part, "");
        return estimate(part);
      }
      const skills = takeSection("skills");
      const memory = takeSection("project_context");
      const mcpInstructions = takeSection("mcp_servers");
      const files = (options.contextFiles ?? []).map(file => ({ name: file.path, tokens: estimate(file.content) }));
      const compaction = pi.getSettings().compaction ?? {};
      const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
      const reserve = compaction.modelOverrides?.[modelKey]?.reserveTokens ?? compaction.reserveTokens ?? defaultCompaction?.reserveTokens;
      ctx.ui.setStatus(contextCommand, JSON.stringify({
        request, systemTools, systemPrompt: estimate(prompt.trim()), skills, memory, mcpInstructions,
        mcp: [...groups.values()], files,
        autoCompaction: compaction.enabled ?? defaultCompaction?.enabled,
        reserve: Number.isSafeInteger(reserve) && reserve >= 0 ? reserve : null
      }));
    }
  });
}
