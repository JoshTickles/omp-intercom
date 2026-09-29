import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import type { SessionInfo } from "./types.ts";

// Integration coverage for the omp-intercom Straker fork: auto-enrolment names,
// profile presence, roster injection, fuzzy targets, and subagent exclusion.

const repoDir = process.cwd();
const homeDir = mkdtempSync(path.join(tmpdir(), "omp-intercom-peers-home-"));
const previousHome = process.env.HOME;
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
// Importing after HOME is redirected pins the broker socket inside homeDir.
const { IntercomClient } = await import("./broker/client.ts");
const { getBrokerProcessArgv } = await import("./broker/spawn.ts");
const { default: piIntercomExtension } = await import("./index.ts");
process.on("exit", () => {
  process.env.HOME = previousHome;
  rmSync(homeDir, { recursive: true, force: true });
});

function makeRepo(name: string): string {
  const dir = path.join(homeDir, "repos", name);
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

async function startBroker() {
  const argv = getBrokerProcessArgv(path.join(repoDir, "broker", "broker.ts"));
  const broker = spawn(argv[0], argv.slice(1), { cwd: repoDir, env: { ...process.env, HOME: homeDir }, stdio: ["ignore", "pipe", "pipe"] });
  const ready = Promise.withResolvers<void>();
  const timeout = setTimeout(() => ready.reject(new Error("broker startup timed out")), 10000);
  broker.stdout!.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes("Intercom broker started")) ready.resolve();
  });
  broker.once("exit", (code) => ready.reject(new Error(`broker exited ${code}`)));
  await ready.promise.finally(() => clearTimeout(timeout));
  const observer = new IntercomClient();
  await observer.connect({ name: "observer", cwd: homeDir, model: "m", pid: process.pid, startedAt: 0, lastActivity: Date.now() });
  return {
    observer,
    async stop() {
      await observer.disconnect().catch(() => undefined);
      broker.kill("SIGTERM");
      await once(broker, "exit").catch(() => undefined);
    },
  };
}

interface Tool {
  name: string;
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
}

function createSession(options: { cwd: string; sessionId: string; subagent?: boolean; title?: { name: string; source: "auto" | "user" } }) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools: Tool[] = [];
  const bus = new EventEmitter();
  let sessionName = options.title?.name;
  let titleSource = options.title?.source;
  const sent: Array<{ content?: string }> = [];
  const pi = {
    getSessionName: () => sessionName,
    setSessionName: (name: string) => { sessionName = name; titleSource = "user"; },
    events: { on: (c: string, h: (p: unknown) => void) => { bus.on(c, h); return () => bus.off(c, h); }, emit: (c: string, p: unknown) => bus.emit(c, p) },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerMessageRenderer: () => undefined,
    registerTool: (tool: Tool) => tools.push(tool),
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    sendMessage: (message: { content?: string }) => sent.push(message),
    appendEntry: () => undefined,
  };
  const ctx = {
    cwd: options.cwd,
    mode: "print",
    model: { id: "test-model" },
    hasUI: false,
    isIdle: () => true,
    abort: () => undefined,
    sessionManager: {
      getSessionId: () => options.sessionId,
      getEntries: () => (options.subagent ? [{ type: "session_init" }] : []),
      getBranch: () => [],
      getHeader: () => ({ titleSource }),
    },
  };
  piIntercomExtension(pi as never);
  return {
    ctx,
    sent,
    tool: () => tools.find((tool) => tool.name === "intercom")!,
    async emit(event: string, payload: unknown = {}) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
      return results;
    },
  };
}

async function waitFor(observer: InstanceType<typeof IntercomClient>, predicate: (sessions: SessionInfo[]) => boolean, what: string): Promise<SessionInfo[]> {
  const deadline = Date.now() + 3000;
  let sessions: SessionInfo[] = [];
  while (Date.now() < deadline) {
    sessions = await observer.listSessions();
    if (predicate(sessions)) return sessions;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}; saw ${JSON.stringify(sessions.map((s) => s.name))}`);
}

test("unnamed sessions auto-join with repo-derived names, disambiguated per repo, flagged as non-mailbox identities", async () => {
  const { observer, stop } = await startBroker();
  const mfDir = makeRepo("model-factory");
  const first = createSession({ cwd: mfDir, sessionId: "mf-one" });
  const second = createSession({ cwd: path.join(mfDir), sessionId: "mf-two" });
  try {
    await first.emit("session_start");
    await waitFor(observer, (s) => s.some((x) => x.id === "mf-one" && x.name === "model-factory"), "first auto-name");
    await second.emit("session_start");
    const sessions = await waitFor(observer, (s) => s.some((x) => x.id === "mf-two" && x.name === "model-factory-2"), "second auto-name");
    const one = sessions.find((s) => s.id === "mf-one")!;
    const two = sessions.find((s) => s.id === "mf-two")!;
    assert.equal(one.name, "model-factory", "first session keeps its name");
    assert.equal(one.runtimeFallbackAlias, true);
    assert.equal(two.runtimeFallbackAlias, true);
    assert.equal(one.profile?.repo, "model-factory");
    assert.equal(one.profile?.branch, "main");
  } finally {
    await first.emit("session_shutdown");
    await second.emit("session_shutdown");
    await stop();
  }
});

test("an explicit alias wins over the auto-name; an OMP auto title is published as activity instead", async () => {
  const { observer, stop } = await startBroker();
  const dir = makeRepo("ledger");
  const aliased = createSession({ cwd: dir, sessionId: "aliased", title: { name: "leadership", source: "user" } });
  const titled = createSession({ cwd: dir, sessionId: "titled", title: { name: "Board report draft", source: "auto" } });
  try {
    await aliased.emit("session_start");
    await titled.emit("session_start");
    const sessions = await waitFor(observer, (s) => s.some((x) => x.id === "aliased") && s.some((x) => x.id === "titled" && x.name === "ledger"), "both sessions");
    const explicit = sessions.find((s) => s.id === "aliased")!;
    const auto = sessions.find((s) => s.id === "titled")!;
    assert.equal(explicit.name, "leadership");
    assert.equal(explicit.runtimeFallbackAlias, false);
    assert.equal(auto.profile?.title, "Board report draft");
  } finally {
    await aliased.emit("session_shutdown");
    await titled.emit("session_shutdown");
    await stop();
  }
});

test("before_agent_start appends a fresh peer roster to the system prompt and publishes redacted intent", async () => {
  const { observer, stop } = await startBroker();
  const mf = createSession({ cwd: makeRepo("model-factory"), sessionId: "roster-mf" });
  const lead = createSession({ cwd: makeRepo("ledger"), sessionId: "roster-lead" });
  try {
    await mf.emit("session_start");
    await lead.emit("session_start");
    await waitFor(observer, (s) => s.some((x) => x.id === "roster-mf") && s.some((x) => x.id === "roster-lead"), "both peers");

    const base = ["BASE PROMPT"];
    const [first] = await lead.emit("before_agent_start", { prompt: "prep the board pack, token=sk-abcdefghijklmnopqrst", systemPrompt: base }) as Array<{ systemPrompt: string[] }>;
    assert.equal(first.systemPrompt.length, 2);
    assert.equal(first.systemPrompt[0], "BASE PROMPT");
    const roster = first.systemPrompt[1]!;
    assert.match(roster, /<omp-intercom-peers>/);
    assert.match(roster, /You are "ledger"/);
    assert.match(roster, /- model-factory — model-factory/);
    assert.doesNotMatch(roster, /- ledger/);

    // Refreshed, not accumulated: a second preparation from the same base yields one roster block.
    const [second] = await lead.emit("before_agent_start", { prompt: "next", systemPrompt: base }) as Array<{ systemPrompt: string[] }>;
    assert.equal(second.systemPrompt.length, 2);

    const published = await waitFor(observer, (s) => Boolean(s.find((x) => x.id === "roster-lead")?.profile?.intent), "intent");
    const intent = published.find((x) => x.id === "roster-lead")!.profile!.intent!;
    assert.doesNotMatch(intent, /sk-abcdefghijklmnopqrst/);
  } finally {
    await mf.emit("session_shutdown");
    await lead.emit("session_shutdown");
    await stop();
  }
});

test("intercom send resolves a role phrase to a unique peer and returns candidates when ambiguous", async () => {
  const { observer, stop } = await startBroker();
  const mfDir = makeRepo("model-factory");
  const mf = createSession({ cwd: mfDir, sessionId: "fuzzy-mf" });
  const lead = createSession({ cwd: makeRepo("ledger"), sessionId: "fuzzy-lead" });
  try {
    await mf.emit("session_start");
    await lead.emit("session_start");
    await waitFor(observer, (s) => s.some((x) => x.id === "fuzzy-mf") && s.some((x) => x.id === "fuzzy-lead"), "peers");

    const sent = await lead.tool().execute("t1", { action: "send", to: "the MF agent", message: "hello" }, new AbortController().signal, undefined, lead.ctx);
    assert.equal(sent.details?.delivered, true, sent.content[0]?.text);
    assert.match(sent.content[0]!.text, /model-factory \(matched "the MF agent"\)/);
    const deadline = Date.now() + 2000;
    while (mf.sent.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(mf.sent[0]?.content ?? "", /hello/);

    const mf2 = createSession({ cwd: mfDir, sessionId: "fuzzy-mf-2" });
    await mf2.emit("session_start");
    await waitFor(observer, (s) => s.some((x) => x.id === "fuzzy-mf-2" && x.name === "model-factory-2"), "second mf");
    const ambiguous = await lead.tool().execute("t2", { action: "send", to: "model factory", message: "who?" }, new AbortController().signal, undefined, lead.ctx);
    assert.equal(ambiguous.details?.error, true);
    assert.equal(ambiguous.details?.ambiguous, true);
    assert.deepEqual([...(ambiguous.details?.candidates as string[])].sort(), ["model-factory", "model-factory-2"]);
    assert.match(ambiguous.content[0]!.text, /matches 2 peers/);

    // Exact names still bypass fuzzy matching.
    const exact = await lead.tool().execute("t3", { action: "send", to: "model-factory-2", message: "exact" }, new AbortController().signal, undefined, lead.ctx);
    assert.equal(exact.details?.delivered, true);
    await mf2.emit("session_shutdown");
  } finally {
    await mf.emit("session_shutdown");
    await lead.emit("session_shutdown");
    await stop();
  }
});

test("subagent sessions never register, get no roster, and cannot use the tool", async () => {
  const { observer, stop } = await startBroker();
  const child = createSession({ cwd: makeRepo("model-factory"), sessionId: "child-session", subagent: true });
  try {
    await child.emit("session_start");
    await child.emit("turn_start");
    const results = await child.emit("before_agent_start", { prompt: "do work", systemPrompt: ["BASE"] });
    assert.deepEqual(results, [undefined]);
    const result = await child.tool().execute("t", { action: "list" }, new AbortController().signal, undefined, child.ctx);
    assert.equal(result.details?.error, true);
    // Negative proof against a real out-of-process broker: give the startup
    // connect timer (setTimeout 0) and a registration round-trip time to happen.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await observer.listSessions()).some((s) => s.id === "child-session"), false);
  } finally {
    await child.emit("session_shutdown");
    await stop();
  }
});
