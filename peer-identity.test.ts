import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  derivePeerBaseName,
  isSubagentSession,
  readGitInfo,
  reconcileAutoName,
  splitSessionName,
  summarizeIntent,
} from "./peer-identity.ts";
import type { SessionInfo } from "./types.ts";

function peer(id: string, name: string, startedAt: number, runtimeFallbackAlias = true): SessionInfo {
  return { id, name, runtimeFallbackAlias, cwd: "/x", model: "m", pid: 1, startedAt, lastActivity: startedAt };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-intercom-identity-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readGitInfo names a linked worktree after its main repo and records the worktree and branch", () => {
  withTempDir((dir) => {
    const main = path.join(dir, "model-factory");
    const gitDir = path.join(main, ".git");
    const wtGitDir = path.join(gitDir, "worktrees", "mf-feature");
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(wtGitDir, "HEAD"), "ref: refs/heads/feature/x\n");
    writeFileSync(path.join(wtGitDir, "commondir"), "../..\n");
    const worktree = path.join(dir, "elsewhere", "mf-feature");
    mkdirSync(path.join(worktree, "src"), { recursive: true });
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);

    assert.deepEqual(readGitInfo(path.join(main)), { repo: "model-factory", branch: "main" });
    assert.deepEqual(readGitInfo(path.join(worktree, "src")), {
      repo: "model-factory",
      worktree: "mf-feature",
      branch: "feature/x",
    });
  });
});

test("derivePeerBaseName prefers the worktree name, then the repo, then the directory", () => {
  assert.equal(derivePeerBaseName("/a/b", { repo: "model-factory" }, "/home/j"), "model-factory");
  assert.equal(derivePeerBaseName("/a/b", { repo: "omp-intercom", worktree: "omp-intercom-a2a" }, "/home/j"), "omp-intercom-a2a");
  assert.equal(derivePeerBaseName("/tmp/Some Dir!", undefined, "/home/j"), "some-dir");
  assert.equal(derivePeerBaseName("/home/j", undefined, "/home/j"), "home");
});

test("reconcileAutoName disambiguates a later same-repo session with a numeric suffix", () => {
  const first = peer("aaa", "model-factory", 100);
  assert.equal(reconcileAutoName({ base: "model-factory", current: "model-factory", self: { id: "bbb", startedAt: 200 }, peers: [first] }), "model-factory-2");
  const second = peer("bbb", "model-factory-2", 200);
  assert.equal(reconcileAutoName({ base: "model-factory", current: "model-factory", self: { id: "ccc", startedAt: 300 }, peers: [first, second] }), "model-factory-3");
});

test("reconcileAutoName keeps the earlier session's name when a later one races for it", () => {
  const later = peer("bbb", "model-factory", 200);
  assert.equal(reconcileAutoName({ base: "model-factory", current: "model-factory", self: { id: "aaa", startedAt: 100 }, peers: [later] }), "model-factory");
});

test("reconcileAutoName never reclaims a freed name mid-session and yields to explicit aliases", () => {
  // model-factory went away; the -2 session keeps its name instead of churning.
  assert.equal(reconcileAutoName({ base: "model-factory", current: "model-factory-2", self: { id: "bbb", startedAt: 200 }, peers: [] }), "model-factory-2");
  // An explicit alias holder always wins, even against an older auto-named session.
  const explicit = peer("zzz", "model-factory", 999, false);
  assert.equal(reconcileAutoName({ base: "model-factory", current: "model-factory", self: { id: "aaa", startedAt: 1 }, peers: [explicit] }), "model-factory-2");
});

test("reconcileAutoName never takes a name an offline explicit session still holds a mailbox for", () => {
  assert.equal(reconcileAutoName({ base: "planner", self: { id: "aaa", startedAt: 1 }, peers: [], reserved: ["Planner"] }), "planner-2");
  // A session that already took the name before the mailbox was known moves off it.
  assert.equal(reconcileAutoName({ base: "planner", current: "planner", self: { id: "aaa", startedAt: 1 }, peers: [], reserved: ["planner"] }), "planner-2");
});

test("summarizeIntent keeps the first line and masks credentials", () => {
  assert.equal(summarizeIntent("\n  fix the flaky eval job\nsecond line"), "fix the flaky eval job");
  const masked = summarizeIntent("deploy with OPENAI_API_KEY=sk-abcdefghijklmnop123 and token ghp_abcdefghijklmnopqrstu");
  assert.ok(masked);
  assert.doesNotMatch(masked, /sk-abcdefghijklmnop123|ghp_abcdefghijklmnopqrstu/);
  assert.match(masked, /OPENAI_API_KEY=\[redacted]/);
  assert.equal(summarizeIntent("word ".repeat(100))?.length, 100);
});

test("isSubagentSession detects OMP's session_init entry and fails safe on unreadable state", () => {
  assert.equal(isSubagentSession({ getEntries: () => [{ type: "message" }] }), false);
  assert.equal(isSubagentSession({ getEntries: () => [{ type: "session_init" }, { type: "message" }] }), true);
  assert.equal(isSubagentSession({ getEntries: () => { throw new Error("released"); } }), true);
});

test("splitSessionName treats OMP auto titles as activity, not identity", () => {
  assert.deepEqual(splitSessionName("Fix eval flake", { getHeader: () => ({ titleSource: "auto" }) }), { title: "Fix eval flake" });
  assert.deepEqual(splitSessionName("mf", { getHeader: () => ({ titleSource: "user" }) }), { explicitName: "mf" });
  assert.deepEqual(splitSessionName("mf", undefined), { explicitName: "mf" });
  assert.deepEqual(splitSessionName("  ", undefined), {});
});
