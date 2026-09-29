import { basename } from "node:path";
import type { SessionInfo } from "./types.ts";

// omp-intercom (Straker fork): resolve "the MF agent" / "model factory" /
// "leadership" to a live peer from its name, repo, role and activity.

const STOPWORDS: Record<string, true> = Object.fromEntries([
  "a", "an", "the", "my", "our", "your", "to", "of", "for", "in", "on", "with",
  "agent", "agents", "session", "sessions", "peer", "bot", "instance", "terminal",
  "omp", "pi", "chat", "one", "guy", "please", "that", "this",
].map((word) => [word, true]));

/** Query tokens that look like a session id or id prefix are left to exact/prefix resolution. */
const ID_LIKE = /^[0-9a-f]{4,}(?:-[0-9a-f]{0,12})*$/i;

export interface PeerMatchCandidate {
  session: SessionInfo;
  score: number;
}

export type PeerMatchResult =
  | { kind: "unique"; session: SessionInfo; score: number }
  | { kind: "ambiguous"; candidates: PeerMatchCandidate[] }
  | { kind: "none" };

function tokens(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

interface FieldIndex {
  strong: Set<string>;
  weak: Set<string>;
  /** Joined forms ("modelfactory") and acronyms ("mf") of multi-word strong fields. */
  compounds: Set<string>;
}

function indexSession(session: SessionInfo): FieldIndex {
  const profile = session.profile ?? {};
  const strongFields = [session.name, profile.repo, profile.worktree, profile.role];
  const weakFields = [profile.title, profile.intent, profile.branch, basename(session.cwd)];
  const strong = new Set<string>();
  const compounds = new Set<string>();
  for (const field of strongFields) {
    const parts = tokens(field).filter((token) => !/^\d+$/.test(token));
    for (const part of parts) strong.add(part);
    if (parts.length > 1) {
      compounds.add(parts.join(""));
      compounds.add(parts.map((part) => part[0]).join(""));
    }
  }
  const weak = new Set<string>();
  for (const field of weakFields) {
    for (const part of tokens(field)) weak.add(part);
  }
  return { strong, weak, compounds };
}

function scoreToken(token: string, index: FieldIndex): number {
  if (index.strong.has(token) || index.compounds.has(token)) return 3;
  if (token.length >= 3) {
    for (const value of index.strong) {
      if (value.startsWith(token)) return 2;
    }
  }
  if (index.weak.has(token)) return 1;
  if (token.length >= 4) {
    for (const value of index.weak) {
      if (value.startsWith(token)) return 1;
    }
  }
  return 0;
}

/**
 * Every meaningful query token must match somewhere; the best-scoring session
 * wins only when it is strictly ahead of the rest. Ties are ambiguous and are
 * returned to the caller instead of guessed.
 */
export function matchPeer(query: string, sessions: SessionInfo[]): PeerMatchResult {
  const raw = query.trim();
  if (!raw || ID_LIKE.test(raw)) return { kind: "none" };
  const queryTokens = tokens(raw).filter((token) => !STOPWORDS[token]);
  if (queryTokens.length === 0) return { kind: "none" };
  const joinedQuery = queryTokens.join("");

  const candidates: PeerMatchCandidate[] = [];
  for (const session of sessions) {
    const index = indexSession(session);
    let score = 0;
    if (queryTokens.length > 1 && index.compounds.has(joinedQuery)) {
      score = 3 * queryTokens.length;
    } else {
      for (const token of queryTokens) {
        const tokenScore = scoreToken(token, index);
        if (tokenScore === 0) {
          score = 0;
          break;
        }
        score += tokenScore;
      }
    }
    if (score > 0) candidates.push({ session, score });
  }
  if (candidates.length === 0) return { kind: "none" };
  candidates.sort((a, b) => b.score - a.score || (a.session.name ?? a.session.id).localeCompare(b.session.name ?? b.session.id));
  const [best, runnerUp] = candidates;
  if (!runnerUp || best!.score > runnerUp.score) {
    return { kind: "unique", session: best!.session, score: best!.score };
  }
  return { kind: "ambiguous", candidates: candidates.filter((candidate) => candidate.score === best!.score) };
}
