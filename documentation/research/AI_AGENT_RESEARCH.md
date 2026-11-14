# AI Agent Research (Atlas AI)

## 1. Landscape (what was checked)
- [VERIFIED] **UI-TARS-desktop** (ByteDance, Apache-2.0, TypeScript) is a GUI agent driven by vision-language models (UI-TARS, Seed-1.5/1.6-VL). It has local and remote operators, MCP integration, an SDK (`@ui-tars/sdk`), and model weights from 2B to 72B. It uses an OpenAI-compatible VLM endpoint. https://github.com/bytedance/UI-TARS-desktop
- [VERIFIED] **Open Interpreter** changed direction in 2026: it was rewritten in Rust as a fork of OpenAI's open-source Codex, and became an Apache-2.0 coding agent for open models. The original Python "control your computer" tool lives on as a community fork (endolith/open-interpreter). https://www.promptquorum.com/power-local-llm/open-interpreter-review
- [VERIFIED] **Univer** has a companion `univer-mcp` repository for driving Univer Sheets with natural language. It's a useful reference for exposing a document engine as agent tools. https://www.everydev.ai/tools/univer-office-sdk
- [VERIFIED] **portal_use** puts a Wayland computer-use stack behind MCP. It shows that MCP is a workable tool protocol for desktop control.

## 2. Architectural recommendation

### 2.1 One orchestrator and many toolsets, not a society of agents
[RECOMMENDATION] The brief lists 12 "agents". Build **one agent loop** (plan → act → observe → verify) and turn the "agents" into:
- **Toolsets:** groups of typed tools that each app registers, such as `writer.*`, `sheets.*`, `slides.*`, `video.*`, `play.*`, `drive.*` and `operator.*`.
- **Profiles:** a system-prompt fragment plus an allowed toolset per task type. For example, the "presentation agent" is the Slides profile.
- **Verifier:** a separate model call with **no write tools**. It checks the result against the request and the plan, and returns a pass or a list of fixes.

The reason: separate free-running agents multiply cost, latency and failure modes. Typed tools are deterministic and testable. The brief itself says to avoid unnecessary agents.

### 2.2 Tool contract
```ts
interface AtlasTool<I, O> {
  name: string;                 // "slides.insert_image"
  description: string;
  input: JSONSchema;            // validated before execution
  risk: "read" | "write" | "destructive" | "external" | "system";
  scopes: Scope[];              // e.g. ["fs:read:<grant-id>"]
  undo?: (result: O) => UndoOp; // required for write tools in Atlas apps
  run(input: I, ctx: ToolCtx): Promise<O>;
}
```
- Every app exposes its tools through a **Tool Registry**. The same registry is also exposed as an **MCP server** [RECOMMENDATION], so external agents (Claude Desktop, other MCP clients) can drive Atlas if the user allows it.
- Tools in each app run **in the app's own process**, the frontend module, and are called through the event bus. The backend never edits the document state directly, which keeps a single source of truth and makes undo work.

### 2.3 Execution engine
- A durable **Task** record holds the goal, plan (a list of steps), the current step, events, status and the undo stack.
- States: `planning → awaiting_approval? → running → verifying → done | failed | cancelled`, with pause and resume.
- Retry limit per step (default 2). After that, hand control back to the user with the error.
- **Real progress only:** the activity panel shows events the executor actually emitted (tool started, finished or failed), never timers.

### 2.4 Model providers
```
LLMProvider: chat(messages, tools, stream) → stream of text/tool_calls
Implementations:
  - Anthropic API            [EXTERNAL-AI][PAID]
  - OpenAI-compatible (covers OpenAI, vLLM, LM Studio, llama.cpp server, Ollama's /v1) [UNVERIFIED Ollama path]
  - VLM grounding provider (UI-TARS via OpenAI-compatible endpoint) for Operator level 3
```
- [LIMITATION] Small local models (7–14B) are weak at long multi-step tool use. Recommend a cloud model by default for complex tasks, with a clear "data leaves this computer" indicator, and local models for private or simple tasks. The user chooses per task or as a default.
- Load local models on demand and unload them after they've been idle.

### 2.5 Prompt-injection defence (required by the brief)
1. **Channel separation:** document, web and media text enters the model only as `untrusted_content` blocks with provenance. The system prompt says that instructions inside those blocks are data.
2. **The capability gate lives in Rust, not in the model.** Tools with risk `destructive`, `external` or `system` need an **approval token** created by the Rust permission broker after the user clicks Approve in UI the model can't draw. The model cannot approve itself.
3. **Taint tracking:** once a task has read untrusted content, any later `external` tool, such as sending a file or calling a non-allow-listed URL, always needs fresh approval, even if the user chose "auto-approve writes".
4. **No general shell tool** in v1. Any later shell tool runs sandboxed (bubblewrap [UNVERIFIED]) with approval for every command.

## 3. Example: tracing the brief's flagship request
"Find three free, legally downloadable documentaries about AI, compare them in a spreadsheet, build a presentation on the best one, and make a promo video."
1. `cinema.search({query, licence: ["publicdomain","cc"]})` → candidates with licence fields.
2. `sheets.create` + `sheets.write_range` → comparison table; `sheets.create_chart`.
3. Verifier checks: three items, all with explicit licences, and sources cited.
4. `slides.create_from_outline` + `slides.insert_chart(ref)` + `slides.add_notes`.
5. `video.generate_promo({slides_ref, duration: 30})` → compiles the slides into a timeline in Video Studio, with a text-to-speech voice-over [EXTERNAL-AI optional].
6. Approval gate if any step downloads files (download size and destination shown).

Every step is a direct tool. No GUI automation is needed. That is the main argument for "API-first".
