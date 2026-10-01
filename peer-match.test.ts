import { test } from "bun:test";
import assert from "node:assert/strict";
import { matchPeer } from "./peer-match.ts";
import { formatPeerRoster, ROSTER_MAX_CHARS } from "./roster.ts";
import type { PeerProfile, SessionInfo } from "./types.ts";

function session(id: string, name: string, cwd: string, profile: PeerProfile = {}): SessionInfo {
  return { id, name, cwd, model: "m", pid: 1, startedAt: 1, lastActivity: 1, status: "idle", profile };
}

const mf = session("11111111-aaaa", "model-factory", "/Users/j/str/code/model-factory", { repo: "model-factory", title: "Eval pipeline refactor" });
const leadership = session("22222222-bbbb", "ledger", "/Users/j/home/project/ledger", { repo: "ledger", role: "leadership" });
const infra = session("33333333-cccc", "home-k8s", "/Users/j/home/home-k8s", { repo: "home-k8s", title: "Cluster upgrade" });
const peers = [mf, leadership, infra];

test("role phrases resolve to a unique peer via repo acronym, joined words and role", () => {
  for (const query of ["MF agent", "the model factory agent", "modelfactory", "model-factory"]) {
    const result = matchPeer(query, peers);
    assert.equal(result.kind, "unique", query);
    assert.equal(result.kind === "unique" && result.session.id, mf.id, query);
  }
  const lead = matchPeer("leadership", peers);
  assert.equal(lead.kind === "unique" && lead.session.id, leadership.id);
  const k8s = matchPeer("cluster upgrade", peers);
  assert.equal(k8s.kind === "unique" && k8s.session.id, infra.id);
});

test("equally good matches are ambiguous and return every candidate", () => {
  const mf2 = session("44444444-dddd", "model-factory-2", "/Users/j/str/code/model-factory", { repo: "model-factory" });
  const result = matchPeer("MF agent", [...peers, mf2]);
  assert.equal(result.kind, "ambiguous");
  assert.deepEqual(result.kind === "ambiguous" && result.candidates.map((c) => c.session.name).sort(), ["model-factory", "model-factory-2"]);
});

test("unrelated words, stopword-only queries and id-like strings do not fuzzy match", () => {
  assert.equal(matchPeer("database migration", peers).kind, "none");
  assert.equal(matchPeer("the agent", peers).kind, "none");
  assert.equal(matchPeer("11111111", peers).kind, "none");
});

test("roster excludes self, stays within its size cap, and summarises overflow", () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    session(`id-${index}`, `peer-${String(index).padStart(2, "0")}`, `/very/long/path/${"x".repeat(60)}/${index}`, { repo: `repo-${index}`, title: "t".repeat(150) }));
  const roster = formatPeerRoster({ selfName: "me", selfId: "id-0", sessions: many, homeDir: "/nowhere" });
  assert.ok(roster.length <= ROSTER_MAX_CHARS, `roster length ${roster.length}`);
  assert.doesNotMatch(roster, /- peer-00 /);
  assert.match(roster, /…and \d+ more/);
  assert.ok(roster.startsWith("<omp-intercom-peers>") && roster.endsWith("</omp-intercom-peers>"));
});

test("roster stays within its size cap for any peer count and line length, and with a huge self name", () => {
  for (let count = 1; count <= 60; count += 1) {
    for (let width = 20; width <= 220; width += 9) {
      const sessions = Array.from({ length: count }, (_, index) =>
        session(`id-${index}`, `peer-${String(index).padStart(2, "0")}`, `/${"d".repeat(width)}`, { repo: "r" }));
      const roster = formatPeerRoster({ selfName: "me", selfId: "me", sessions, homeDir: "/nowhere" });
      assert.ok(roster.length <= ROSTER_MAX_CHARS, `${count} peers × ${width}: ${roster.length}`);
    }
  }
  const huge = formatPeerRoster({ selfName: "x".repeat(3000), selfId: "me", sessions: [session("q", "q", "/q")], homeDir: "/nowhere" });
  assert.ok(huge.length <= ROSTER_MAX_CHARS, `huge self name: ${huge.length}`);
});

test("roster lists repo, role and activity but never volatile status", () => {
  const roster = formatPeerRoster({ selfName: "home-k8s", selfId: infra.id, sessions: peers, homeDir: "/Users/j" });
  assert.match(roster, /You are "home-k8s"/);
  assert.match(roster, /- model-factory — model-factory · ~\/str\/code\/model-factory — working on: Eval pipeline refactor/);
  assert.match(roster, /- ledger — ledger · ~\/home\/project\/ledger — role: leadership/);
  assert.doesNotMatch(roster, /idle/);
  assert.doesNotMatch(roster, /- home-k8s/);
});
