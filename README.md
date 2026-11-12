# dsh-orchestrator

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) orchestrator. It adds an **Orchestrator** agent preset and four tools that see, inspect, message, and interrupt the other live agents in the same Harness process.

No terminal multiplexer, no external CLI, no screen scraping. It reads the live agent registry (`ctx.agents`) and each session's committed event log directly.

## What it adds

One install gives you two things:

1. **The `orchestrator` agent preset** — a standard manager toolset (shell, files, search, jobs, schedule, skills, goals, compaction, delegation, web, todo) plus the four fleet tools. It appears in Settings → Agent presets and in the new-session picker.
2. **Four tools, admitted only to agents running that preset:**
   - `fleet_roster` — every live agent, running first, with status, current tool call, last assistant message, preset, model, turn/step, last activity age, parent, children, queued input, and todo progress.
   - `fleet_inspect` — one agent in depth: recent messages, open tool calls, pending approval, queued input, todos, goal, children.
   - `fleet_message` — deliver a message to any live agent. Running targets get it at their next step; idle targets start a new turn. One-way delivery.
   - `fleet_interrupt` — cancel another agent's active turn, keeping or clearing its queued input.

The plugin also contributes a role section that explains the management loop. No other agent's tool catalog or prompt changes: every registration is gated by a step-time `when` that checks the live preset.

## How it sees

Agent visibility is read live from `ctx.agents` — the process-wide agent registry — on every call. There is no cached roster and no polling.

Activity is derived from each session's own committed event log (the last 240 events): open `tool/call` events without a `tool/result` are the work in progress, an unanswered `approval/asked` is a blocked approval, an open `ask_user_question` call is a waiting user, and the last `assistant/message` text is what the agent last said. Derived working state (title, todos, goal, queued inbox) comes from `ctx.sessionProjections`, read with an explicit key list so the roster never pays for unrelated projections.

## Use it

1. Install the bundle through DSH's plugin manager (or `install_bundle` with this directory).
2. Start a new session with the **Orchestrator** preset, or set it as the new-task default in Settings → Agent presets.
3. Ask it what the fleet is doing, or hand it work: “watch the three agents I started and tell me which one is stuck”, “stop the docs agent and tell it to wait for the API change”.

The orchestrator spawns workers with `subagent`, and those workers are composed with the `standard` preset, so they are coders rather than more orchestrators. Edit `agentPreset` in `cordis.patch.yml` to change that.

## Manual install

```sh
dsh plugin --profile web add link:/path/to/dsh-orchestrator
```

Then add the bundle to the profile's `dsh.profile.bundles`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@haroon0x/dsh-orchestrator"
      ]
    }
  }
}
```

Refresh the web app. Plugin Manager and HMR replace linked packages on recomposition; a manual install outside Plugin Manager may need a restart.

## Design notes and limits

- **One-way messages.** A target does not reply into the orchestrator's conversation. Results are observed through the roster, or delivered automatically only when the orchestrator started that agent itself.
- **Same process only.** Agents served by a different `dsh` process are not visible; this is the live registry, not a cross-host bus.
- **Bounded output.** Roster rows default to 20 (max 50) and messages are truncated. `fleet_inspect` returns the last 8 messages by default (max 30).
- **Self-protection.** `fleet_message` and `fleet_interrupt` refuse the caller's own id; the roster marks that row `self`.
- **Interrupt is cooperative.** `fleet_interrupt` requests cancellation and returns; the target may stay `running` until it observes the signal.
- **Preset coupling.** The `orchestrator` preset copies the shipped standard plugin list. A Harness upgrade that changes standard's composition does not update this copy; edit `cordis.patch.yml` when you want new shipped plugins.

## Tests

```sh
npm test
```

The tests run against a fake Cordis context: no DSH install, no model calls, no subprocess.

## License

MIT
