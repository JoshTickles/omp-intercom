<p>
  <img src="banner.png" alt="omp-intercom" width="1100">
</p>

# Omp Intercom

Direct 1:1 messaging between [omp](https://github.com/can1357/oh-my-pi) sessions on the same machine. Send context, findings, or requests from one session to another — whether you're driving the conversation or letting agents coordinate.

Port of [pi-intercom](https://github.com/earendil-works/pi-intercom) to the omp extension API.

> **Straker fork (`0.2.0-straker.x`).** This fork ([josh-at-straker/omp-intercom](https://github.com/josh-at-straker/omp-intercom), upstream [ersintarhan/omp-intercom](https://github.com/ersintarhan/omp-intercom)) makes agent-to-agent messaging a default for every OMP session: automatic enrolment with readable names, published peer profiles, a live peer roster in each agent's context, and role/fuzzy targeting ("send the MF agent a hello"). See [Straker fork additions](#straker-fork-additions). Local-only: no network beyond the local broker socket.

```text
User flow: press Alt+I or run /intercom to pick a session and send a message
```

## Why

Sometimes you're running multiple omp sessions — one researching, one executing, one reviewing. Omp-intercom lets you:

- **User-driven orchestration** — Send context or findings from your research session to your execution session
- **Agent collaboration** — An agent can reach out to another session when it needs help or wants to share results
- **Session awareness** — See what other omp sessions are running and their current status

This fills the gap omp's built-ins leave open: `/collab` shares *one* session with multiple viewers (1 agent, N humans), and the Agent Hub manages subagents *inside* one process. Omp-intercom connects two independent, fully separate omp instances as peers.

## Straker fork additions

New behaviour lives in new modules (`peer-identity.ts`, `peer-match.ts`, `roster.ts`) with small hooks in `index.ts` and an additive, optional `profile` field in the broker protocol, so upstream changes still merge.

### Automatic enrolment and stable auto-names

Every top-level OMP session that loads the plugin joins the broker on start (the broker auto-spawns if absent). A session without an explicit alias takes a readable name derived from where it runs:

| Where the session runs | Auto-name |
|---|---|
| git repo `~/str/code/model-factory` | `model-factory` |
| second session in the same repo | `model-factory-2` (then `-3`, …) |
| linked worktree `omp-intercom-a2a` of repo `omp-intercom` | `omp-intercom-a2a` |
| plain directory `/tmp/x` | `x` |

- `/alias <name>` (or any user rename) always wins.
- OMP's auto-generated session title is **not** treated as a name; it is published as the peer's current activity.
- Names are stable for a session's lifetime: only the loser of a startup race renames (the later-started session, or any auto-name colliding with an explicit alias), and a freed name is never reclaimed mid-session.
- Auto-names are published as `runtimeFallbackAlias`, so the broker never transfers queued mail by them. Upstream's safety property holds: a different process can never inherit another's mailbox through a derived name. Only explicit aliases are reconnect identities.

### Peer profiles

Presence carries a short, secret-free profile: `repo`, `worktree`, `branch`, `role` (set by `/intercom-role <role>` or `$OMP_INTERCOM_ROLE`), `title` (OMP's session title), `intent` (first line of the latest prompt, with credential-looking tokens masked and the length clipped), and `terminal` (Orca terminal handle or tmux pane). The broker validates and caps every field. No environment, tokens or full prompts are published.

### Peer roster in context, without prompting

On every prompt preparation (`before_agent_start`) the extension appends a compact `<omp-intercom-peers>` block to the system prompt: your own name, then one line per live peer (name, repo, cwd, role, what it's working on), capped at 12 peers and 2,000 characters with an overflow line. It is a per-preparation replacement of the system prompt, rebuilt from the base every time, so it is refreshed rather than accumulated and never written to the transcript. Volatile status (idle/thinking) stays out of the block to keep the provider prompt cache warm; `intercom({ action: "list" })` shows live status.

### Role / fuzzy targets

`to` resolves an exact id, then an exact name, then an id prefix (upstream order), and only then fuzzy-matches live peers' names, repos, worktrees, roles and activity. So `"the MF agent"`, `"model factory"` and `"leadership"` resolve without the user supplying an id. When peers tie, the call fails and lists the candidates instead of guessing. The tool description and roster tell the model to look peers up itself and never ask the user for a session id.

### Subagents never enrol

OMP writes a `session_init` entry into every task, eval, `/tan` and revived subagent session before `session_start`; top-level sessions never have one. Sessions with that entry do not register, get no roster, cannot claim an auto-name, and the `intercom` tool refuses in them. Subagents coordinate with their parent through OMP's native IRC and Agent Hub. If the session state is unreadable, the check fails safe and the session does not enrol.

### Shared instructions (`AGENTS.md`)

A short `<omp-intercom>` usage note is appended to `~/.omp/agent/AGENTS.md`. On Josh's machine that path is a symlink to `~/.pi/agent/AGENTS.md`, so Pi agents read the same file. The section therefore opens with a scope line telling Pi agents to ignore it (Pi uses pi-intercom with a separate broker at `~/.pi/agent/intercom`). The same guidance also ships inside the plugin, in the tool description, the bundled skill and the roster block, so it works without the AGENTS.md note.

## In One Minute

Each omp session that has `omp-intercom` loaded and enabled connects to a tiny local broker over a local IPC transport. The broker keeps track of connected sessions and routes direct messages to the one you target by name or session ID. The extension gives you both a tool (`intercom`) and a small overlay UI (`/intercom` or `Alt+I`). Incoming messages are rendered inline inside the recipient session, can trigger a turn immediately by default, and are also stored in session history as extension entries. If you want a stricter local trust posture, `inboundTrigger` can reduce or disable auto-triggering.

## Install

Fork install (local checkout, pinned to whatever the checkout has checked out):

```bash
cd /path/to/omp-intercom      # omp plugin link only accepts paths inside the cwd
bun install                   # dev deps for tests only; the runtime uses omp's own packages
omp plugin link .
omp plugin list               # → omp-intercom@0.2.0-straker.1
```

Roll back: `omp plugin uninstall omp-intercom` (removes the link and lockfile entry; the broker exits on its own when idle).

Upstream npm install: `omp install npm:omp-intercom`.

New omp sessions load the plugin on startup, auto-connect to the broker, and register the bundled `omp-intercom` skill. Already-running sessions pick it up only after a restart or reload.

Under omp (Bun) the broker runs `broker.ts` directly with the current Bun executable. Under Node it falls back to the bundled `tsx` CLI (override with `brokerCommand`/`brokerArgs`).

**Recommended:** Add this snippet to your project's `AGENTS.md` to help agents understand when to coordinate across sessions:

```xml
<omp-intercom>
Coordinate with other local omp sessions on related codebases. Use `/skill:omp-intercom` for patterns.

**When:** Same codebase (parallel work), reference codebase (consulting patterns), related repos (shared libraries).

**Not when:** Unrelated codebases, trivial questions, or when you can proceed independently.

**Principle:** Prefer `send` for notifications; `ask` only when blocked waiting for input.
</omp-intercom>
```

A session becomes intercom-connected when all of these are true:
- the `omp-intercom` extension is installed and loaded in that session
- `enabled` is not set to `false` in the intercom config file, which defaults to `~/.omp/agent/intercom/config.json`
- the session has started or reloaded after the extension was installed
- the local broker is running or can be auto-started

The session list only shows intercom-connected sessions, not every open omp process on the machine.

If a session is unnamed and auto-naming is disabled (`"autoName": false`), omp-intercom exposes upstream's collision-resistant runtime-only fallback alias, like `omp-chat-1a2b3c4d-5e6f-7a8b`. Like auto-names, that alias is not persisted as the omp session title or treated as a reconnect identity, so an unnamed process cannot inherit another unnamed session's queued mail after a restart.

### Name your current session

Use `/alias <name>` as an omp-intercom-friendly way to name the current session:

```text
/alias api-worker
```

The alias is omp's session name, so it is persisted in the session and immediately
published to omp-intercom peers. Session lists, send/reply results, overlays, and
incoming message headers use it when available. In an interactive UI, `/alias`
or `/alias menu` opens an input for the current session's alias; it does not
rename other sessions. Use `/alias <name>` in non-UI modes.

## Quick Start

### From the Keyboard

Press **Alt+I** or type `/intercom` to open the session list overlay:

1. **Select a session** — Use arrow keys to pick a target session
2. **Compose message** — Write your message in the compose overlay
3. **Send** — Press Enter to send, Escape to cancel

(Alt+M in pi-intercom is reserved by omp, so the shortcut moved to Alt+I.)

### From the Agent

The agent can list sessions and send messages using the `intercom` tool. Tool calls and results render as compact transcript rows so send/ask/reply flows are easy to scan. Use `/intercom-id` to insert a handoff snippet for the current session's stable intercom target into the editor. For common patterns like planner-worker delegation, the bundled `omp-intercom` skill provides copy-paste ready examples:

```typescript
// List active sessions
intercom({ action: "list" })
// → **Current session:**
// → • executor (20d43841) — ~/projects/api (kimi-k2 · 42% ctx) [self, idle]
// → **Other sessions:**
// → • research (6332faab) — ~/projects/api (kimi-k2) [same cwd, thinking]

// List only peers in the same working directory
intercom({ action: "list-cwd" })

// Send a message
intercom({ action: "send", to: "research", message: "Check if UserService.validate() handles null" })
// → Message sent to research

// Check connection status
intercom({ action: "status" })
// → Connected: Yes, Session ID: abc123, Active sessions: 3

// Send with attachments (code snippets, files, or context)
intercom({
  action: "send",
  to: "worker",
  message: "Here's the fix:",
  attachments: [{
    type: "snippet",
    name: "auth.ts",
    language: "typescript",
    content: "function validate() { ... }"
  }]
})
```

### Ask and wait for a reply

`ask` blocks until the target replies (10-minute default, configurable via `PI_INTERCOM_ASK_TIMEOUT_MS`):

```typescript
intercom({ action: "ask", to: "planner", message: "JWT or session cookies?" })
// → **Reply from planner:** Session cookies — we're browser-first.
```

Reply to an inbound ask naturally with `reply`:

```typescript
intercom({ action: "reply", message: "Session cookies — we're browser-first." })
```

### Target by working directory

Scope a send/ask to the sole live session in another repo:

```typescript
intercom({
  action: "send",
  cwd: "/home/me/projects/billing",
  message: "Let's discuss the billing retry design in this repo."
})
```

## Configuration

Create `~/.omp/agent/intercom/config.json`:

```json
{
  "enabled": true,
  "confirmSend": false,
  "inboundTrigger": "always",
  "sessionId": "stable-intercom-id"
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | Set `false` to disconnect and hide intercom |
| `confirmSend` | `false` | Interactive confirmation before `send` |
| `inboundTrigger` | `"always"` | `"always"` triggers a turn on inbound messages; `"replies"` only triggers for ask replies; `"never"` renders inline without triggering |
| `sessionId` | unset | Pin a restart-stable intercom session ID |
| `autoName` | `true` | Fork: derive a repo/worktree name for sessions without an alias (`false` restores `omp-chat-…`) |
| `peerRoster` | `true` | Fork: append the live `<omp-intercom-peers>` roster to top-level sessions' system prompt |

Environment: `OMP_INTERCOM_ROLE` sets a default role for the session's peer profile; `/intercom-role <role>` (persisted in the session) overrides it, and `/intercom-role clear` clears it.

By default, runtime state and config live under `~/.omp/agent/intercom`. If omp is launched with `PI_CODING_AGENT_DIR` (omp's own agent-dir override), omp-intercom uses `$PI_CODING_AGENT_DIR/intercom` instead, including `config.json`, broker PID/lock files, sockets, and launcher state.

## Runtime Files

Runtime files live at `~/.omp/agent/intercom/` by default, or `$PI_CODING_AGENT_DIR/intercom/` when `PI_CODING_AGENT_DIR` is set:

- `broker.sock` — Unix domain socket for communication (macOS/Linux only; Windows uses a named pipe instead)
- `broker-launch.vbs` — Windows helper script used to launch the broker without a console window
- `broker.pid` — Broker process ID
- `broker.spawn.lock` — Startup lock preventing double-spawn
- `pending-asks/` — Local records of blocking asks awaiting replies

## How It Works

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│ omp session │◄───────►│    broker    │◄───────►│ omp session │
│  (planner)  │  local  │ (auto-spawn) │  local  │  (worker)   │
└─────────────┘   IPC   └──────────────┘   IPC   └─────────────┘
```

- **Broker** — Tiny local process (`broker/broker.ts`) that tracks connected sessions and routes direct messages. Auto-spawns on first use; exits when idle.
- **Extension** — Each session runs `index.ts`, which registers the `intercom` tool, the `/intercom`, `/intercom-id`, `/alias`, `/intercom-role` commands, the `Alt+I` shortcut, presence heartbeats, the peer roster hook, and the inline message renderer.
- **Transport** — Unix domain socket on macOS/Linux; named pipe on Windows (opt-in TCP loopback via `PI_INTERCOM_TRANSPORT=tcp` for restricted environments). Session IDs are the trusted addressing key; duplicate names fail closed on ambiguous sends.
- **Presence** — Sessions advertise name, cwd, model, context-window usage, live status (`idle` / `thinking` / `tool:<name>`) and (fork) a peer profile so peers can pick a good target.
- **Mailbox** — Messages to recently disconnected named sessions are queued and redelivered when the same name+cwd reconnects. Runtime-only `omp-chat-...` aliases are not reconnect identities.

## Extension Channels

Other extensions in the same session can use omp-intercom as a message bus: register a namespace over the shared `pi.events` bus, get an owner-elected channel with per-namespace state, and publish/send payloads to the owning session. See `extension-api.ts` for the `INTERCOM_EXTENSION_REGISTER_EVENT` contract and the outbox request/result events for consent-gated sends.

## Differences from pi-intercom

- Targets the omp extension API (`@oh-my-pi/*` packages, `omp` package manifest)
- Shortcut is **Alt+I** (omp reserves Alt+M)
- Runtime state lives under `~/.omp/agent/intercom`
- Model presence refreshes at `turn_start` (omp has no `model_select` event)
- The `pi-subagents` bridge (`contact_supervisor`, subagent relay events) and the Herdr `openProjectPaneIfMissing` flow are not ported; omp's subagents communicate through the built-in Agent Hub instead
- Tests run on `bun test`

## Development

```bash
bun install
bun run test    # 208 tests
```

The broker is runtime-agnostic (plain Node APIs); the extension and UI layers import `@oh-my-pi/*` packages and require Bun.

## License

MIT
