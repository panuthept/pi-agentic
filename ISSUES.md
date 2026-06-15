# Issues & Code Quality Concerns — pi-agentic Extension

> **Last updated:** 2026-06-16
>
> Total: **28 issues** — 5 HIGH, 16 MEDIUM, 7 LOW
>
> Breakdown: 3 Bugs, 6 Potential Bugs, 7 Code Smells, 2 Security, 4 Design, 4 Performance, 4 Cross-Cutting

---

## Severity Key

| Badge | Meaning |
|-------|---------|
| 🔴 **HIGH** | Definite runtime error, data corruption, or complete feature breakage |
| 🟡 **MEDIUM** | Likely failure under edge conditions, significant code quality concern |
| 🟢 **LOW** | Minor quality issue, negligible impact, cosmetic |

---

## 1 — BUGS: Definite Runtime Errors or Incorrect Behavior

### 🔴 HIGH 1.1 — Widget system entirely non-functional

| Field | Value |
|-------|-------|
| **File(s)** | `widget.ts:56,62,87-89`, `index.ts` (multiple call sites) |
| **Category** | Bug |
| **First seen** | Initial implementation (intentional stub, call sites not removed) |

**Description**

`pushWidgetUpdate()`, `finalizeWidget()`, and `createSubagentWidget.render()` are all no-op stubs bearing the comment `// Widget removed — no-op`. Every call to these functions in `index.ts` is dead code — the entire live-status-bar widget system does nothing visible. However, `reinstallWidget(ctx)` is still called from multiple locations:

- `index.ts` ~line 60 (session_start handler)
- `index.ts` ~line 259 (wrappedOnUpdate — every tool call step)
- `index.ts` ~line 264 (after tool completion)
- `index.ts` ~line 313 (parallel mode emit)
- `index.ts` ~line 349-350 (parallel mode finalize)

Each call registers a no-op widget component that renders nothing, wasting CPU cycles and confusing maintainers.

**Impact**

- Users see no live subagent status bar despite the extension attempting to provide one.
- Every tool execution step pays the cost of `ui.setWidget()` for an invisible widget.
- Future maintainers reading the code will assume the widget works and may introduce bugs based on that assumption.

**Recommendation**

Either **(a)** remove the `reinstallWidget()` call sites and delete the widget module entirely, or **(b)** implement the widget rendering logic that was stubbed out.

---

### 🔴 HIGH 1.2 — Payload mutation causes ever-growing system prompts

| Field | Value |
|-------|-------|
| **File(s)** | `index.ts:130-146` (`injectAgentInstructions`) |
| **Category** | Bug |
| **Risk** | Cumulative — degrades over time |

**Description**

`injectAgentInstructions()` mutates the event payload's `system` field by appending:

```ts
obj.system += injection;
```

If the same payload object is reused across turns (which the pi framework does for `before_provider_request` events), the agent instructions string grows with each turn. This causes ever-expanding system prompts that degrade model performance, increase token costs, and may eventually exceed provider context limits.

**Impact**

- **Token waste:** Each turn doubles (or accumulates) the injected instructions.
- **Model confusion:** The model sees repeated identical instructions, which can distort attention and degrade output quality.
- **Silent cost increase:** User pays for repeated tokens with no benefit.

**Recommendation**

Replace mutation with a copy-on-write pattern:

```ts
function injectAgentInstructions(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  if (!_currentAgent || !_agentCatalog) return payload;
  const def = _agentCatalog.get(_currentAgent);
  if (!def?.instructions) return payload;

  const obj = { ...payload } as Record<string, unknown>;
  const injection = "\n\n[AGENT: " + _currentAgent.toUpperCase() + "]" + def.instructions;

  if (typeof obj.system === "string") {
    obj.system = obj.system + injection;     // re-assign, don't += in-place
  } else if (Array.isArray(obj.system)) {
    obj.system = [...obj.system, { type: "text", text: injection }];
  }
  // ... handle messages array similarly with a shallow copy ...
  return obj;
}
```

Or better, ensure the framework sends a fresh payload per turn (framework-side fix).

---

### 🔴 HIGH 1.3 — Case-sensitive agent lookup fails on `/agent` command

| Field | Value |
|-------|-------|
| **File(s)** | `index.ts:197-200` (`/agent` command handler) |
| **Category** | Bug |

**Description**

When the user selects an agent from the interactive menu, the picked name is lowercased:

```ts
const picked = choice.split(" — ")[0].toLowerCase();
if (_agentCatalog.has(picked)) { ... }
```

But `_agentCatalog` is a `Map<string, AgentConfig>` keyed by the `name` field from frontmatter, which retains its original casing. For any agent whose frontmatter `name:` contains uppercase letters (e.g. `name: DocAgent`), `_agentCatalog.has("docagent")` returns `false` and the selection is **silently discarded** — the agent is not switched and no error is shown.

**Impact**

- Users cannot select agents with uppercase names via the interactive menu.
- The action fails silently, so users have no indication anything went wrong.
- Combined with issue **2.4** (silent failure), this creates a confusing UX.

**Recommendation**

Normalize the catalog keys at creation time, or use a case-insensitive lookup:

```ts
// Option A: Normalize keys on catalog creation (loadAgentCatalog)
catalog.set(frontmatter.name.toLowerCase(), { name: frontmatter.name, ... });

// Option B: Case-insensitive lookup in the handler
const picked = choice.split(" — ")[0];
const key = [..._agentCatalog.keys()].find(k => k.toLowerCase() === picked.toLowerCase());
if (key) { applyAgent(key, pi); ... }
```

---

## 2 — POTENTIAL BUGS: Edge Cases, Race Conditions, Null/Undefined Risks

### 🔴 HIGH 2.1 — `JSON.stringify` throws on non-serializable tool args

| Field | Value |
|-------|-------|
| **File(s)** | `render.ts:104` (render cache key in `renderSubagentCall`) |
| **Category** | Potential Bug |

**Description**

The render cache key is computed via:

```ts
const key = JSON.stringify({ args, executionStarted: context.executionStarted, argsComplete: context.argsComplete, width });
```

`args` comes directly from the tool call's parameter object. If any parameter value contains a **circular reference**, **BigInt**, **`undefined`** value, **Symbol**, or **Function**, `JSON.stringify` throws a `TypeError`, crashing the render cycle.

Tool parameters can potentially include complex nested objects, and while most LLM providers avoid non-serializable values, a malformed or edge-case tool call would cause a hard crash rather than graceful degradation.

**Impact**

- Complete render failure (crash) if tool call args contain non-serializable values.
- Could crash the entire TUI render pipeline if unhandled.

**Recommendation**

Wrap the cache key computation in a try/catch, falling back to a non-cached render:

```ts
let key: string;
try { key = JSON.stringify({ args, ... }); }
catch { key = ""; }  // Skip cache on serialization failure
```

---

### 🟡 MEDIUM 2.2 — Loader pool race on concurrent cold acquire

| Field | Value |
|-------|-------|
| **File(s)** | `loader-pool.ts:84-108` (`acquire()`) |
| **Category** | Potential Bug (Race Condition) |

**Description**

If two `acquire()` calls arrive simultaneously when the pool is empty and no warming is in progress, both calls:

1. Pop from idle → both get `undefined`.
2. Check warming → both see `undefined`.
3. Both create a new loader and call `reload()`.

The second loader is eventually pushed to the idle queue after warming completes, while the first is returned directly. This wastes memory with a duplicate loader and inflates cold-start time.

**Impact**

- On concurrent startup (e.g., parallel subagent calls), `n` simultaneous acquires create `n` loaders instead of 1.
- Memory waste (each loader holds extension/resource graph).
- Extra CPU time for redundant `reload()` calls.

**Recommendation**

Use a mutex/lock around the creation path:

```ts
private pendingCreate = new Map<string, Promise<void>>();

async acquire(...): Promise<LoaderLease> {
  const k = this.key(cwd, agentDir, noExtensions);
  // ... (idle pop logic same as before) ...

  // Check if another acquire is already creating a loader
  let createPromise = this.pendingCreate.get(k);
  if (!createPromise) {
    createPromise = this.createLoader(k, cwd, agentDir, noExtensions);
    this.pendingCreate.set(k, createPromise);
  }
  await createPromise;
  // Now retry the idle pop
  // ...
}
```

---

### 🟡 MEDIUM 2.3 — `_agentCtx` dangling reference not nulled on shutdown

| Field | Value |
|-------|-------|
| **File(s)** | `index.ts:60,123` |
| **Category** | Potential Bug |

**Description**

`_agentCtx` is set in `session_start` but never reset to `null` after `session_shutdown`. If `session_shutdown` fires twice (defensive framework behavior), the second call uses whatever stale reference remains in `_agentCtx`. Additionally, closures captured during the session may hold a reference to `_agentCtx` that outlives the session.

**Impact**

- Double-shutdown could call `ui.setWidget` on a disposed context.
- Closures over `_agentCtx` (from background jobs or detached promises) could use a dangling reference after session end.

**Recommendation**

Null `_agentCtx` at the end of `session_shutdown`:

```ts
pi.on("session_shutdown", async () => {
  clearAgentWidget();
  getBgManager().shutdown();
  _bgManager = null;
  _setBgStatus = null;
  _agentCtx = null;          // <-- add this
  _currentAgent = undefined; // <-- and this for consistency
  defaultLoaderPool.clear();
});
```

---

### 🟡 MEDIUM 2.4 — Silent failure on agent selection

| Field | Value |
|-------|-------|
| **File(s)** | `index.ts:197-201` (`/agent` command) |
| **Category** | Potential Bug |

**Description**

When the case-mismatch from issue **1.3** causes `_agentCatalog.has(picked)` to return `false`, the code simply returns without any notification:

```ts
const picked = choice.split(" — ")[0].toLowerCase();
if (_agentCatalog.has(picked)) {
  applyAgent(picked, pi);
  persistAgent();
  ui.ui.notify("Agent: " + picked.toUpperCase(), "info");
}
// No else branch — silent return
```

The user sees their selected agent highlighted in the menu, but nothing changes.

**Impact**

- Confusing UX: user selects an agent, menu closes, but agent doesn't switch.
- No error message to guide the user.

**Recommendation**

Add an else branch with a notification:

```ts
if (_agentCatalog.has(picked)) {
  applyAgent(picked, pi);
  persistAgent();
  ui.ui.notify("Agent: " + picked.toUpperCase(), "info");
} else {
  ui.ui.notify(`Agent "${picked}" not found (case mismatch?).`, "error");
}
```

---

### 🟡 MEDIUM 2.5 — `parseDuration` accepts `"0s"` creating nonsensical rolling window

| Field | Value |
|-------|-------|
| **File(s)** | `timeline-handler.ts:21-28` (`parseDuration`) |
| **Category** | Potential Bug |

**Description**

The regex `/^(\d+)\s*(s|sec|m|min|h|hr)?$/` accepts `"0s"`, `"0m"`, `"0h"` — all producing `0` milliseconds as the rolling window. A 0ms window filters entries to only those with `endTime > now - 0 && startTime < now`, which effectively shows nothing unless an entry has a start and end at exactly the current millisecond.

**Impact**

- User can configure a timeline window that silently shows nothing.
- No validation or warning that 0 is invalid.

**Recommendation**

```ts
function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)\s*(s|sec|m|min|h|hr)?$/);
  if (!match) return null;
  const val = parseInt(match[1]!, 10);
  if (val <= 0) return null;   // <-- reject zero
  ...
}
```

---

### 🟢 LOW 2.6 — Silent parse error swallowing in `loadAgentCatalog`

| Field | Value |
|-------|-------|
| **File(s)** | `index.ts:97-112` (`loadAgentCatalog`) |
| **Category** | Potential Bug |

**Description**

Malformed `.md` files in the agent directory are silently skipped with an empty `catch {}` block. Users have no indication that a file failed to load.

**Recommendation**

Log the error (at least to stderr) so users can diagnose why an agent isn't appearing:

```ts
catch (e) {
  console.warn(`[fast-subagent] Skipping malformed agent file: ${join(dir, f)} — ${e instanceof Error ? e.message : e}`);
}
```

---

### 🟢 LOW 2.7 — `_assignedColors` maps never cleared across sessions

| Field | Value |
|-------|-------|
| **File(s)** | `timeline.ts:78-82`, `execution-timeline-widget.ts:80-84` |
| **Category** | Potential Bug (Memory / Cross-session) |

**Description**

Module-level `_assignedColors` maps persist forever. While the memory leak is tiny (bounded by distinct agent names encountered), the persistent state means color assignments carry across sessions, which is unexpected for a fresh session.

**Recommendation**

Reset the maps on `clearTimelineHistory()` or `session_shutdown`.

---

## 3 — CODE SMELLS: Duplication, Complexity, Naming Issues

### 🟡 MEDIUM 3.1 — Duplicate agent-color logic in two files

| Field | Value |
|-------|-------|
| **File(s)** | `timeline.ts:30-75`, `execution-timeline-widget.ts:48-85` |
| **Category** | Code Smell |

**Description**

Both `timeline.ts` and `execution-timeline-widget.ts` contain identical copies of:

- The `AGENT_COLORS` array (26 ANSI escape code strings)
- The `getAgentColor()` function
- The `_assignedColors` Map
- The `_colorIndex` counter
- The `RESET_FG` constant

Each module maintains its own `_assignedColors` map, so the **same agent gets different colors** in the Gantt render (`timeline.ts`) vs. the widget render (`execution-timeline-widget.ts`).

**Impact**

- DRY violation — any change to the palette must be duplicated.
- Visual inconsistency — agent appears in different colors in different contexts.
- ~70 lines of nearly identical code across two files.

**Recommendation**

Extract a shared `agent-colors.ts` module that exports `getAgentColor()`, `resetColorAssignments()`, and the palette constants. Import from both files.

---

### 🟡 MEDIUM 3.2 — `formatDuration` defined 3 ways with inconsistent formatting

| Field | Value |
|-------|-------|
| **File(s)** | `format.ts:55-58`, `timeline.ts:54-59`, `execution-timeline-widget.ts:102-107` |
| **Category** | Code Smell |

**Description**

Three independent implementations with different output formats:

| Location | Output for 5003ms | Output for 300ms |
|----------|------------------|-------------------|
| `format.ts` | `"5m 3s"` | `"0s"` |
| `timeline.ts` | `"5.0s"` | `"300ms"` |
| `execution-timeline-widget.ts` | `"  5s  "` (padded) | `"300ms".padStart(5)` |

This inconsistency means the same duration can be displayed differently depending on which module renders it.

**Recommendation**

Standardize on one implementation in `format.ts` and remove the others. Import from `format.ts` everywhere.

---

### 🟡 MEDIUM 3.3 — `_baselineTools` assigned but never read

| Field | Value |
|-------|-------|
| **File(s)** | `index.ts:59,77` |
| **Category** | Code Smell (Dead variable) |

**Description**

```ts
let _baselineTools = [];           // line 59 (declaration)
_baselineTools = pi.getAllTools().map(t => t.name);  // line 77 (assignment)
```

The variable is never read after assignment. It appears to be leftover from an earlier implementation that compared baseline vs. agent-specific tools.

**Recommendation**

Remove the declaration and assignment.

---

### 🟡 MEDIUM 3.4 — `agentScope` parameter defined but never implemented

| Field | Value |
|-------|-------|
| **File(s)** | `schemas.ts:49-55`, `index.ts` |
| **Category** | Code Smell (API surface / dead parameter) |

**Description**

The `SubagentParams` schema defines `agentScope` as an optional union of `"user" | "project" | "both"` with default `"both"`. However, `discoverAgents()` in `index.ts` is called unconditionally without any filtering — the parameter is silently ignored.

**Impact**

- Misleading API surface — users may set `agentScope` expecting it to work.
- If anyone relies on this parameter, they'll get all agents regardless of scope.
- Future implementers may be confused about whether the parameter is used.

**Recommendation**

Either implement the filtering:

```ts
if (params.agentScope) {
  const filtered = agents.filter(a => params.agentScope === "both" || a.source === params.agentScope);
  // use filtered
}
```

Or remove `agentScope` from the schema.

---

### 🟡 MEDIUM 3.5 — `reinstallWidget` and `reinstallTimelineWidget` called on every tool call

| Field | Value |
|-------|-------|
| **File(s)** | `index.ts:259-264` (wrappedOnUpdate), also parallel mode `311-313` |
| **Category** | Code Smell (Performance / Over-invalidation) |

**Description**

Every tool execution step triggers full widget re-registration via `setWidget`:

```ts
const wrappedOnUpdate: OnUpdate | undefined = onUpdate
  ? (partial) => {
      if (forwardUpdates) (onUpdate as unknown as OnUpdate)(partial);
      if (partial.details) {
        const d = partial.details as SubagentDetails;
        pushWidgetUpdate(d);
        reinstallWidget(ctx);          // <-- every update
        tlRecordUpdate(tlEntryId, { ... });
        reinstallTimelineWidget(ctx);  // <-- every update
      }
    }
  : undefined;
```

Each `setWidget` call re-registers the component factory, which triggers TUI re-rendering. For a long-running agent with many tool calls (10-30+), this means 10-30+ unnecessary widget re-registrations.

**Impact**

- Unnecessary CPU overhead during tool execution.
- Could cause visual flicker in the TUI.
- Masks the fact that neither widget actually renders anything (see issue **1.1**).

**Recommendation**

Use a state-invalidation approach instead of full re-registration. Have the widget component read module-level state and call `requestRender()` rather than re-registering.

---

### 🟢 LOW 3.6 — `[..._fgJobs.values()][0]` fragile pattern

| Field | Value |
|-------|-------|
| **File(s)** | `index.ts:185-195` (Ctrl+Shift+B handler) |
| **Category** | Code Smell |

**Description**

```ts
const entry = [..._fgJobs.values()][0];
```

This pattern assumes Map iteration order (insertion order) and grabs the first entry. It's safe-guarded with a null check, but it's fragile — if the Map has entries and the first one happens to be stale, the wrong job is targeted.

**Recommendation**

Expose a more explicit "most recent foreground job" function, or iterate to find the right entry.

---

### 🟢 LOW 3.7 — Unconventional field name `subagentDepth`

| Field | Value |
|-------|-------|
| **File(s)** | `agents.ts:107` |
| **Category** | Code Smell |

**Description**

```ts
const maxDepth = parseMaxDepthField(
  frontmatter.maxDepth ?? frontmatter.max_depth ?? frontmatter.depth ?? frontmatter.subagentDepth,
);
```

The field `subagentDepth` uses camelCase while most convention-following users would expect `subagent_depth` or `max_subagent_depth`. The existing conventional field `max_depth` is checked, but `subagentDepth` is non-standard and won't be found by users following typical frontmatter conventions.

**Recommendation**

Remove the unconventional alias or add the snake_case equivalent `subagent_depth`. Standardize on `maxDepth` / `max_depth` as canonical.

---

## 4 — SECURITY ISSUES

### 🟡 MEDIUM 4.1 — Agent instructions injected into provider payload without sanitization

| Field | Value |
|-------|-------|
| **File(s)** | `index.ts:130-146` (`injectAgentInstructions`) |
| **Category** | Security |

**Description**

Raw text from agent `.md` files is concatenated into the LLM provider's system prompt:

```ts
const injection = "\n\n[AGENT: " + _currentAgent.toUpperCase() + "]" + def.instructions;
obj.system += injection;
```

The `def.instructions` content comes from the body of user-authored `.md` files (or project `.md` files committed to repositories). If a malicious `.md` file is introduced (e.g., via a compromised dependency, a PR from an untrusted contributor, or a user downloading an agent file from an untrusted source), the instructions could contain **prompt injection** content designed to override system behavior, extract conversation data, or manipulate the model.

**Impact**

- An attacker who can place a `.md` file in the agent directory can inject arbitrary prompt text into the LLM context.
- This could override safety instructions, extract sensitive data, or manipulate model outputs.
- Risk increases if agents are shared or downloaded from untrusted sources.

**Recommendation**

Consider adding:
1. A content security warning when loading agents from project directories.
2. Optional content validation or a blocklist of known injection patterns.
3. Documentation warning users about the risks of untrusted agent files.
4. At minimum, visually demarcate the injection boundary more clearly in the prompt.

---

### 🟢 LOW 4.2 — Symlink following in agent directories

| Field | Value |
|-------|-------|
| **File(s)** | `agents.ts:62-65` |
| **Category** | Security |

**Description**

```ts
if (!entry.isFile() && !entry.isSymbolicLink()) continue;
```

Symlinks in agent directories are explicitly followed. A symlink could point to arbitrary files outside the intended agent directory, potentially reading sensitive files as agent instructions.

**Recommendation**

Consider whether symlink following is needed. If not, remove the `isSymbolicLink()` check. If it is needed, add a check that the resolved path is within the intended agent directory.

---

## 5 — DESIGN FLAWS

### 🔴 HIGH 5.1 — Widget stubbed without removing call sites

| Field | Value |
|-------|-------|
| **File(s)** | `widget.ts` (entire file), `index.ts` (multiple call sites) |
| **Category** | Design |

**Description**

The entire widget system was reduced to no-ops but every call site remains active. This is the worst of both worlds: users get no widget, and the code does useless work. The `reinstallWidget()` function is called at least 7 times during a typical subagent execution, each time registering a component that renders nothing.

**Impact**

- Dead code paths executed on every tool call.
- New contributors see the call sites and assume the widget works.
- ~300 lines of dead code in `widget.ts` plus call site overhead.

**Recommendation**

Choose one path and commit to it:
- **Remove:** Delete `widget.ts` and all `reinstallWidget()` calls.
- **Restore:** Implement the actual widget rendering logic.

---

### 🟡 MEDIUM 5.2 — Pervasive module-level mutable state

| Field | Value |
|-------|-------|
| **File(s)** | `index.ts`, `widget.ts`, `timeline.ts`, `execution-timeline-widget.ts`, `loader-pool.ts`, `runner.ts`, `background-job-manager.ts` |
| **Category** | Design |

**Description**

Module-level mutable state is used extensively across the codebase:

| File | Module-level state |
|------|-------------------|
| `index.ts` | `_bgManager`, `_onBgJobComplete`, `_setBgStatus`, `_fgJobs`, `_currentAgent`, `_agentCatalog`, `_baselineTools`, `_agentCtx` |
| `widget.ts` | `_data` |
| `timeline.ts` | `_assignedColors`, `_colorIndex` |
| `execution-timeline-widget.ts` | `_state`, `_assignedColors`, `_colorIndex`, `_maxVisibleBars`, `_rollingWindowMs`, `_timeMode`, `_barWidthRatio`, `_cachedWidth`, `_cachedLines` |
| `runner.ts` | `_authStorage`, `_modelRegistry` |
| `loader-pool.ts` | `defaultLoaderPool` singleton |
| `background-job-manager.ts` | Instance-level `Map`s |

**Impact**

- **Unit testing impossible** without careful module reset between tests.
- **Concurrent sessions** (if the framework ever supports them) would corrupt each other's state.
- Reasoning about code flow is difficult because any function can mutate shared state.
- The `_state` object in `execution-timeline-widget.ts` is mutated in-place from many call sites.

**Recommendation**

- Encapsulate mutable state in classes or factory functions that can be instantiated per-session.
- For the timeline widget, consider a proper state management pattern (e.g., a store with explicit actions).
- Reduce the scope of module-level state to only what's absolutely necessary for singletons (like `_authStorage` and `_modelRegistry`).

---

### 🟡 MEDIUM 5.3 — AsyncLocalStorage not cleaned up if `fn` hangs

| Field | Value |
|-------|-------|
| **File(s)** | `runner.ts:57-59` (`runWithDepth`) |
| **Category** | Design |

**Description**

```ts
export function runWithDepth<T>(state: DepthState, fn: () => Promise<T>): Promise<T> {
  return _depthContext.run(state, fn);
}
```

The `AsyncLocalStorage` context remains set if the async function hangs (e.g., a never-resolving promise). While the risk is low because `session.prompt()` is bounded by signal/timeout, any subsequent async operations on the same chain would inherit the wrong depth context.

**Impact**

- Low risk in practice due to timeouts, but a subtle cross-contamination vector.
- If a nested subagent call hangs and a new call starts on the same async chain, it inherits the stuck depth state.

**Recommendation**

Consider adding a timeout wrapper:

```ts
export async function runWithDepth<T>(state: DepthState, fn: () => Promise<T>, timeoutMs = 300_000): Promise<T> {
  return _depthContext.run(state, async () => {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Depth context timeout")), timeoutMs)
      ),
    ]);
    return result;
  });
}
```

---

### 🟢 LOW 5.4 — Shared `settings.json` write race

| Field | Value |
|-------|-------|
| **File(s)** | `execution-timeline-widget.ts:216-227` (`saveTimelineSettings`) |
| **Category** | Design |

**Description**

`saveTimelineSettings` does a read-modify-write on a shared file (`settings.json`) without any locking:

```ts
let full: Record<string, unknown> = {};
if (existsSync(SETTINGS_PATH)) {
  try { full = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")); } catch { /* ignore */ }
}
full.timeline = { ... };
writeFileSync(SETTINGS_PATH, JSON.stringify(full, null, 2), "utf-8");
```

If two instances write simultaneously (or another extension writes to the same file), one write will clobber the other. Write errors are silently caught.

**Recommendation**

At minimum, log write errors. Consider switching to an atomic write pattern (write to temp file, rename) or using a proper config store.

---

## 6 — PERFORMANCE ISSUES

### 🟡 MEDIUM 6.1 — Heartbeat fires every second for entire agent duration

| Field | Value |
|-------|-------|
| **File(s)** | `runner.ts:182-261` (`runAgent`) |
| **Category** | Performance |

**Description**

A `setInterval` at 1 second fires during the entire agent execution:

```ts
emitUpdate();
const heartbeat = setInterval(emitUpdate, 1000);
// ...
done = true;
clearInterval(heartbeat);
```

For an agent that runs 60 seconds, this produces 60 ticks. Each tick:
1. Calls `onUpdate` which triggers widget and timeline re-renders.
2. Creates a fresh `SubagentDetails` object.
3. Copies the `toolCalls` array (spreading).

When the agent is idle (waiting for LLM response), nothing meaningful changes between ticks.

**Impact**

- 60+ unnecessary function calls per minute per agent.
- Each call propagates through the widget/timeline update chain.
- For parallel agents with `n` concurrent runs, the waste scales linearly.

**Recommendation**

- Use a dynamic heartbeat: increase interval when no events have arrived recently (e.g., back off to 5s after 15s of inactivity).
- Or skip heartbeat when `emitUpdate` was already called via event subscription within the last second.

---

### 🟡 MEDIUM 6.2 — Timeline widget heartbeat re-renders every 500ms

| Field | Value |
|-------|-------|
| **File(s)** | `execution-timeline-widget.ts:249-262` (`createTimelineWidget`) |
| **Category** | Performance |

**Description**

The timeline widget registers a `setInterval` at 500ms that invalidates the cache and requests a full re-render:

```ts
_heartbeatTimer = setInterval(() => {
  if (!hasRunning()) { clearInterval(_heartbeatTimer!); _heartbeatTimer = null; return; }
  clearCached();
  tui.requestRender();
}, 500);
```

Each re-render:
1. Filters entries by rolling window.
2. Reverses and slices entries.
3. Computes min/max timestamps.
4. Builds the Gantt bar character by character for each entry.
5. Computes peak parallelism by sampling 100 points across the timeline.

This is `O(n * 100)` work where `n` is the number of visible entries, done every 500ms.

**Impact**

- Constant CPU load even when no new events are arriving.
- Gantt bar rebuilding on every tick is wasteful — only `duration` and `status` fields change while running.

**Recommendation**

- Throttle to 1-2 seconds when actively running.
- Use incremental rendering: only recompute lines for entries whose state changed.
- Avoid recomputing peak parallelism (static metric) on every tick.

---

### 🟢 LOW 6.3 — `tlFinalizeAllRunning` redundant after per-agent `tlRecordEnd`

| Field | Value |
|-------|-------|
| **File(s)** | `index.ts:349-350` |
| **Category** | Performance (Defensive double-finalization) |

**Description**

In the parallel mode handler, each agent's completion already calls `tlRecordEnd` (line ~339). Then after all agents finish:

```ts
// Finalize any lingering timeline entries
tlFinalizeAllRunning();
reinstallTimelineWidget(ctx);
```

The `tlFinalizeAllRunning()` call iterates over all entries marking any still-"running" ones as "success". In practice, every entry should already be finalized by the per-agent `tlRecordEnd` call, making this redundant.

**Impact**

- Unnecessary `O(n)` iteration over timeline entries.
- Minor (one extra pass at the end of parallel execution).

**Recommendation**

Remove the defensive `tlFinalizeAllRunning()` call, or document why it's needed (e.g., if `recordEnd` could fail silently).

---

### 🟢 LOW 6.4 — Sync I/O via settings cache TTL

| Field | Value |
|-------|-------|
| **File(s)** | `render.ts:20-22` |
| **Category** | Performance |

**Description**

```ts
const SETTINGS_TTL_MS = 2000;
// ...
if (_settingsCache && now - _settingsCache.readAt < SETTINGS_TTL_MS) return _settingsCache;
// ...
const settings = JSON.parse(readFileSync(path, "utf-8"));
```

A 2-second TTL cache with synchronous `readFileSync` + `JSON.parse` blocks the event loop for every cache miss. During heavy rendering (e.g., fast token-by-token streaming), this can cause jank.

**Impact**

- Event loop blocked for file I/O every 2+ seconds.
- Minor in practice because settings file is small, but the pattern is avoidable.

**Recommendation**

Either:
- Increase the TTL to 30-60 seconds (settings rarely change during a session).
- Use `readFile` (async) to avoid blocking.
- Or only read settings once at startup and cache indefinitely.

---

## 7 — CROSS-CUTTING CONCERNS

### 🟡 MEDIUM 7.1 — `import.meta.url` requires ESM

| Field | Value |
|-------|-------|
| **File(s)** | `agents.ts:11` |
| **Category** | Compatibility |

**Description**

```ts
import { fileURLToPath } from "node:url";
// ...
const here = path.dirname(fileURLToPath(import.meta.url));
```

This breaks under CommonJS resolution. If the package is consumed from a CJS context, this line throws `ReferenceError: import.meta is not defined`.

**Impact**

- Package cannot be used in a CJS project without transpilation.
- Restricts compatibility to ESM-only consumers.

**Recommendation**

If CJS compatibility is desired, use `__dirname` or `require.main.filename` as a fallback. Otherwise, document the ESM requirement.

---

### 🟢 LOW 7.2 — `handle.detach?.()` is always a no-op

| Field | Value |
|-------|-------|
| **File(s)** | `background-job-manager.ts:33-41` (`adoptHandle`) |
| **Category** | Dead code |

**Description**

```ts
adoptHandle(...): string {
  handle.detach?.();    // <-- always no-op
  // ...
}
```

No call site provides an object with a `detach` method. The `BackgroundHandleLike` interface may define it, but every implementation passes an `AbortController`-based handle without `detach`.

**Recommendation**

Remove the `detach` call from `adoptHandle()` and clean up the `BackgroundHandleLike` type if `detach` is unused everywhere.

---

### 🟢 LOW 7.3 — `_onBgJobComplete` race window during extension registration

| Field | Value |
|-------|-------|
| **File(s)** | `index.ts:49-51,56-57` |
| **Category** | Cross-cutting (Race) |

**Description**

`_onBgJobComplete` is assigned at line 49 (`_onBgJobComplete = (job) => { ... }`) during extension registration, but `getBgManager()` is already callable and could receive a job completion event before the assignment. The `onJobComplete` callback is passed at construction time (line 53), which calls `_onBgJobComplete`. There's a tiny window between `getBgManager()` construction and the `_onBgJobComplete` assignment where a background job could complete and call a null callback.

**Impact**

- Extremely narrow window (synchronous code between two lines).
- Would result in a `TypeError: _onBgJobComplete is not a function` if triggered.

**Recommendation**

Assign `_onBgJobComplete` before constructing `_bgManager`, or use a no-op default:

```ts
let _onBgJobComplete: ((job: BackgroundSubagentJob) => void) | null = () => {};  // no-op default
```

---

### 🟢 LOW 7.4 — `recordParallelUpdate` matches by agent name + status instead of entry ID

| Field | Value |
|-------|-------|
| **File(s)** | `execution-timeline-widget.ts:160-175` (`recordParallelUpdate`) |
| **Category** | Cross-cutting (Edge case) |

**Description**

```ts
for (const agent of details.parallelAgents) {
  const entry = _state.entries.find(
    (e) =>
      e.agent === agent.name &&
      e.status === "running" &&
      e.mode === "parallel",
  );
  // ...
}
```

This matches timeline entries by **agent name + status** rather than by a unique ID. If two parallel batches run the **same agent** concurrently, this could update the wrong batch's entries.

**Impact**

- Low probability (requires two overlapping parallel batches with same agent name).
- Would cause incorrect timeline display (wrong entry gets usage/status updates).

**Recommendation**

Pass the entry ID through `SubagentDetails` and use it for direct lookup instead of name-based matching.

---

## Appendix A: Issue Count Summary

| Severity | Count | IDs |
|----------|-------|-----|
| 🔴 **HIGH** | 5 | 1.1, 1.2, 1.3, 2.1, 5.1 |
| 🟡 **MEDIUM** | 16 | 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 5.2, 5.3, 6.1, 6.2, 7.1, 7.4 |
| 🟢 **LOW** | 7 | 2.6, 2.7, 3.6, 3.7, 4.2, 5.4, 6.3, 6.4, 7.2, 7.3 |

| Category | Count | IDs |
|----------|-------|-----|
| Bug | 3 | 1.1, 1.2, 1.3 |
| Potential Bug | 6 | 2.1, 2.2, 2.3, 2.4, 2.5, 2.7 |
| Code Smell | 7 | 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7 |
| Security | 2 | 4.1, 4.2 |
| Design | 4 | 5.1, 5.2, 5.3, 5.4 |
| Performance | 4 | 6.1, 6.2, 6.3, 6.4 |
| Cross-cutting | 4 | 7.1, 7.2, 7.3, 7.4 |

Note: some issues span multiple categories (e.g., 2.1 is both "Potential Bug" and listed here once under its primary category). Total unique issues: **28**.

---

## Appendix B: Quick-Fix Priority

Issues that can be fixed with minimal risk and high impact:

1. **1.2** — Payload mutation → copy-on-write (high impact, low risk)
2. **1.3** — Case-sensitive lookup → normalize or case-insensitive search (high impact, low risk)
3. **2.4** — Silent failure → add error notification (medium impact, trivial fix)
4. **3.3** — Remove dead `_baselineTools` variable (zero risk)
5. **2.5** — Reject zero duration (medium impact, trivial fix)
6. **2.6** — Log parse errors (low impact, trivial fix)
7. **3.1** — Extract shared color module (medium impact, moderate effort)
8. **3.2** — Consolidate `formatDuration` (medium impact, low effort)
9. **7.1** — Document ESM requirement (low effort)
10. **5.4** — Log write errors (low effort)
