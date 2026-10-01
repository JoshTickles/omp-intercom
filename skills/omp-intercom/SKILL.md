---
name: omp-intercom
description: |
  Message other local omp agents (peer sessions) directly. Every top-level omp
  session auto-joins with a repo-derived name and appears in the
  <omp-intercom-peers> roster. Use when the user mentions another agent ("the MF
  agent", "leadership") or for planner-worker delegation, context handoffs, and
  cross-session coordination.
---

# Omp Intercom Skill

Use this skill when you need to coordinate work across multiple omp sessions
running on the same machine. Omp-intercom enables direct 1:1 messaging between
sessions for delegation, context sharing, and collaborative workflows.

## When to Use

- **Task delegation**: Split work between a planner session and worker sessions
- **Context handoffs**: Send findings from a research session to an execution session
- **Clarification loops**: Worker asks questions, planner answers, work continues
- **Multi-session workflows**: Coordinate between specialized sessions (frontend/backend, research/implementation)
- **Cross-codebase peer messages**: Message an explicit live peer in another project

## Peers Are Already Known (Straker fork)

Every top-level omp session joins automatically with a readable name: its git
repo (`model-factory`), its linked worktree dir, or its cwd's name, with `-2`,
`-3`… when two sessions share a repo. `/alias` overrides it. The
`<omp-intercom-peers>` block in your system prompt lists who is online, their
repo and cwd, and what they are working on.

When the user says "tell the MF agent…", "ask leadership…" or "ping the ledger
session", **do not ask for a session id**. Pass their words as `to`:

```typescript
intercom({ action: "send", to: "the MF agent", message: "hello" })
// → Message sent to model-factory (matched "the MF agent")
```

`to` tries an exact id, then an exact name, then an id prefix, then a fuzzy match
on peers' names, repos, roles and current work. If several peers match equally,
the call fails and lists the candidates: pick one, or ask the user which one
they meant.

Inbound messages arrive as turns. The sender cannot see your normal output, so
answer through intercom when a response is warranted: `reply` for asks, a plain
`send` for ordinary messages. Subagents are not peers; use OMP's native IRC or
Agent Hub for those.

`/intercom-role <role>` (or `$OMP_INTERCOM_ROLE`) publishes a role such as
`leadership` that others can target.

## Core Patterns

### Pattern 1: Planner-Worker Delegation

The most common pattern. One session holds the big picture, others do hands-on work.

**Setup** (in each session):
```
/alias planner   # Terminal 1
/alias worker    # Terminal 2
```

**Planner delegates a task** (fire-and-forget):
```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Task-3: Add retry logic to API client. Key files: src/api/client.ts. Ask if anything's unclear."
})
```

**Worker asks for clarification** (blocks until answer):
```typescript
intercom({
  action: "ask",
  to: "planner",
  message: "Should I use exponential backoff or fixed intervals?"
})
// → Returns the planner's reply as the result
```

**Worker reports completion**:
```typescript
intercom({
  action: "ask",
  to: "planner",
  message: "Task-3 complete. Added exponential backoff (100ms → 1600ms, max 5 retries). Ready for task-4?"
})
```

### Pattern 2: Quick Status Check

Before sending, verify who's connected:

```typescript
intercom({ action: "list" })
// → Shows all connected sessions with names, cwd, models, and live status (`idle`, `thinking`, `tool:<name>`)
```

### Pattern 3: Reply Naturally

When responding to an inbound ask, prefer `reply` instead of reconstructing raw IDs:

```typescript
// In the turn triggered by the ask:
intercom({
  action: "reply",
  message: "Use exponential backoff starting at 100ms."
})

// If replying later and there might be more than one pending ask:
intercom({ action: "pending" })
intercom({ action: "reply", to: "planner", message: "Use exponential backoff starting at 100ms." })
```

`reply` still preserves exact threading under the hood by sending the response with the original `replyTo` value.

### Pattern 4: Broadcast to Multiple Workers

Send to multiple sessions in parallel:

```typescript
const workers = ["worker-1", "worker-2", "worker-3"];
const task = "Check for null pointer exceptions in your assigned files";

// Fire-and-forget to all workers
workers.forEach(w => 
  intercom({ action: "send", to: w, message: task })
);
```

### Pattern 5: Send with Attachments

Share code snippets, files, or context:

```typescript
intercom({
  action: "send",
  to: "worker",
  message: "Here's the fix for the auth issue:",
  attachments: [{
    type: "snippet",
    name: "auth.ts",
    language: "typescript",
    content: `function validateUser(user: User | null) {
  if (!user) throw new Error("User required");
  return user.email?.includes("@");
}`
  }]
})
```

### Pattern 6: Cross-Codebase Peer Messages

Use `to` alone to message any explicit live peer on the machine, even when it is
in another codebase. Use `cwd` alone when there should be exactly one live peer
in that repo. Use `to` plus `cwd` when the directory is a safety guard.

```typescript
intercom({
  action: "ask",
  cwd: "/path/to/other-repo",
  to: "workbench-agent",
  message: "Which module owns workbench source slices?"
})
```

If a live session already exists in that `cwd`, intercom reuses it. If multiple
sessions are active there, pass `to` to select one by name or session ID.

## Key Differences

| Action | Behavior | Use When |
|--------|----------|----------|
| `send` | Fire-and-forget; infers the sole pending ask as its reply | You don't need a response |
| `ask` | Blocks until reply (10 min default, configurable with `PI_INTERCOM_ASK_TIMEOUT_MS`) | You need an answer to continue |
| `reply` | Responds to the active or pending inbound ask | You were asked something and need to answer naturally |
| `pending` | Lists unresolved inbound asks | You need to see who is waiting before replying |
| `list` | Returns all sessions with live status | You need to discover targets or choose an idle peer |
| `status` | Returns your connection state | Troubleshooting |

## Important Constraints

### `ask` Limitations

- **Connected targets only**: `ask` fails immediately when the target is not in the live intercom roster. Use `list` before asking when liveness is uncertain; use `send` for non-blocking mailbox delivery.
- **Configurable timeout**: If no reply arrives before the shared ask timeout, the ask fails. The default is 10 minutes; set `PI_INTERCOM_ASK_TIMEOUT_MS` to a positive millisecond value to change it.
- **One at a time**: Cannot have multiple pending asks from the same session
- **Cannot self-target**: A session cannot ask itself, including through disconnected-mailbox remapping

```typescript
// Check if already waiting before asking
const result = await intercom({ action: "ask", to: "planner", message: "..." });
if (result.isError && result.content[0].text.includes("Already waiting")) {
  // Use send instead, or wait for current ask to complete
}
```

### `send` Behavior

- **No timeout**: Message is delivered or fails immediately
- **Sole pending ask inference**: If the destination has exactly one pending inbound ask, `send` attaches its `replyTo` and reports `Reply sent to <target> (inferred from pending ask)`
- **Ambiguity stays unthreaded**: Zero or multiple matching asks leave the send as an ordinary message
- **Confirmation dialogs**: If `confirmSend: true` in config, interactive sessions confirm ordinary and inferred sends
- **Explicit replies skip confirmation**: A caller-supplied `replyTo` skips the dialog

## Best Practices

### Use `ask` for blocking workflows

When the worker needs information to proceed:

```typescript
// GOOD: Worker blocks until planner responds
const reply = await intercom({
  action: "ask",
  to: "planner",
  message: "API rate limit is 100/min. Should I implement client-side throttling or batching?"
});
// Continue with the answer...
```

### Use `send` for notifications

When you just want to inform:

```typescript
// GOOD: Fire-and-forget notification
intercom({
  action: "send",
  to: "reviewer",
  message: "PR #123 is ready for review. Key changes in auth.ts."
});
// Continue immediately, don't wait
```

### Name sessions meaningfully

Use `/alias` so others can target you easily. It names the current session and
is shown in intercom lists, send/reply results, overlays, and incoming headers:

```
/alias api-worker
/alias frontend-dev
/alias planner
```

## Error Handling

### Common Errors and Solutions

**"Already waiting for a reply"**
```typescript
// You can only have one pending ask at a time
// Option 1: Use send instead
intercom({ action: "send", to: "planner", message: "..." });

// Option 2: Wait for current ask to complete first
```

**"Cannot message the current session"**
```typescript
// You cannot target yourself
// This usually means you confused session names - double-check the target
```

**"Session not found"**
```typescript
const result = await intercom({ action: "send", to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" - check the name and list available sessions
  await intercom({ action: "list" });
}
```
Replies to recently disconnected explicitly named senders can be queued by the broker and delivered if that sender reconnects with the same name and directory. Runtime-only `omp-chat-...` aliases are not reconnect identities. New `send` calls may target a known live or recently disconnected session; blocking `ask` calls require a live target.

**Ask timeout**
```typescript
// The ask will reject with a timeout error
// Default: 10 minutes
// Override: set PI_INTERCOM_ASK_TIMEOUT_MS to a positive millisecond value
// For longer tasks, use send + follow-up ask pattern
```

## Troubleshooting

### Session not appearing in list

1. Check intercom is enabled: `intercom({ action: "status" })`
2. Verify the target session has loaded omp-intercom
3. Ensure both sessions are on the same machine (intercom is same-machine only)

### Message not delivered

```typescript
const result = await intercom({ action: "send", to: "worker", message: "..." });
if (!result.delivered) {
  console.log("Failed:", result.reason);
  // → "Session not found" or delivery failure reason
}
```

### Connection lost

Sessions automatically reconnect if the broker restarts. If persistently disconnected:

```typescript
intercom({ action: "status" })
// Check if broker is running and restart if needed
```

## Common Workflows

### Research → Implementation Handoff

```typescript
// Research session finds relevant code
intercom({
  action: "send",
  to: "impl-session",
  message: "Found the bug. The issue is in validateUser() - it doesn't check for null.",
  attachments: [{
    type: "snippet",
    name: "validate.ts",
    language: "typescript",
    content: `// Line 45-52 - missing null check
function validateUser(user: User) {
  return user.email?.includes("@"); // crashes if user is null
}`
  }]
});
```

### Pair Debugging

```typescript
// Session A encounters error
intercom({
  action: "ask",
  to: "session-b",
  message: "Getting 'Cannot read property of undefined' at line 78. Can you check if data.users is populated before this call?"
});

// Session B investigates and replies
intercom({
  action: "reply",
  message: "data.users is null. The fetch failed silently. Add error handling in loadUsers()."
});
```

### Progress Reporting

```typescript
// Worker sends periodic updates
intercom({ action: "send", to: "planner", message: "Task-1 complete (15min). Starting Task-2." });
// ... work ...
intercom({ action: "send", to: "planner", message: "Task-2 complete (30min). Task-3 blocked - need API key." });
// ... get unblocked ...
intercom({ action: "send", to: "planner", message: "Task-3 complete. All done." });
```

### Long-Running Task with Checkpoints

```typescript
// For tasks that might exceed the ask timeout, use send + periodic asks

// 1. Initial send with full context
intercom({
  action: "send",
  to: "worker",
  message: "Implement user authentication. This will take 30+ minutes. I'll check in at milestones."
});

// 2. Worker sends progress via send (no timeout)
intercom({ action: "send", to: "planner", message: "Milestone 1: Login form complete (10min)" });

// 3. Worker asks for specific decision when needed
const decision = await intercom({
  action: "ask",
  to: "planner",
  message: "Should we use JWT or session cookies? Need decision to continue."
});
// Continue with decision...
```
