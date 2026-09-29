import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { PeerProfile, SessionInfo } from "./types.ts";

// omp-intercom (Straker fork): derive who this session is so peers can find it
// without anyone typing /alias or copying session IDs.

export interface GitInfo {
  /** Main repository name; linked worktrees resolve to the repo they belong to. */
  repo: string;
  /** Linked worktree directory name, when it differs from the repo name. */
  worktree?: string;
  branch?: string;
  /** Directory containing the `.git` entry for cwd. */
  root: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function readBranch(gitDir: string): string | undefined {
  const head = readTrimmed(join(gitDir, "HEAD"));
  if (!head) return undefined;
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) return ref[1];
  return /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : undefined;
}

/**
 * Filesystem-only git discovery (no subprocess): walk up from cwd to the first
 * `.git` entry. A `.git` file is either a linked worktree (its gitdir has a
 * `commondir`) or a submodule (no `commondir`).
 */
export function readGitInfo(cwd: string): GitInfo | undefined {
  let dir = resolve(cwd);
  const { root: fsRoot } = parse(dir);
  for (;;) {
    const dotGit = join(dir, ".git");
    let isDir = false;
    let exists = false;
    try {
      const stat = statSync(dotGit);
      exists = true;
      isDir = stat.isDirectory();
    } catch {
      // keep walking
    }
    if (exists) {
      if (isDir) {
        return { repo: basename(dir), root: dir, ...optional("branch", readBranch(dotGit)) };
      }
      const pointer = readTrimmed(dotGit);
      const match = pointer ? /^gitdir:\s*(.+)$/.exec(pointer) : null;
      if (!match) return { repo: basename(dir), root: dir };
      const gitDir = isAbsolute(match[1]!) ? match[1]! : resolve(dir, match[1]!);
      const branch = readBranch(gitDir);
      const commonDirPointer = isFile(join(gitDir, "commondir")) ? readTrimmed(join(gitDir, "commondir")) : undefined;
      if (!commonDirPointer) {
        return { repo: basename(dir), root: dir, ...optional("branch", branch) };
      }
      const commonDir = isAbsolute(commonDirPointer) ? commonDirPointer : resolve(gitDir, commonDirPointer);
      const repo = basename(commonDir) === ".git"
        ? basename(dirname(commonDir))
        : basename(commonDir).replace(/\.git$/, "");
      const worktree = basename(dir);
      return {
        repo,
        root: dir,
        ...(worktree !== repo ? { worktree } : {}),
        ...optional("branch", branch),
      };
    }
    if (dir === fsRoot) return undefined;
    dir = dirname(dir);
  }
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value ? { [key]: value } : {}) as { [P in K]?: string };
}

export function slugifyPeerName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48)
    .replace(/[-.]+$/g, "");
  return slug || "omp";
}

/** Readable base name: linked worktree dir, else repo name, else the cwd's own name. */
export function derivePeerBaseName(cwd: string, git: GitInfo | undefined, homeDir: string | undefined): string {
  if (git) return slugifyPeerName(git.worktree ?? git.repo);
  const resolved = resolve(cwd);
  if (homeDir && resolved === resolve(homeDir)) return "home";
  if (resolved === parse(resolved).root) return "root";
  return slugifyPeerName(basename(resolved));
}

function outranks(a: Pick<SessionInfo, "id" | "startedAt">, b: Pick<SessionInfo, "id" | "startedAt">): boolean {
  return a.startedAt < b.startedAt || (a.startedAt === b.startedAt && a.id < b.id);
}

/**
 * Pick this session's auto-name.
 *
 * Stability rule: a session keeps its current auto-name unless another live
 * session holds the same name AND either chose it explicitly (/alias) or
 * started earlier. Only the loser of a startup race moves, and it moves to the
 * first unused `<base>`, `<base>-2`, `<base>-3`, ... — a name that frees up
 * later is never reclaimed, so names do not churn during a session.
 */
export function reconcileAutoName(options: {
  base: string;
  current?: string;
  self: Pick<SessionInfo, "id" | "startedAt">;
  peers: SessionInfo[];
}): string {
  const peers = options.peers.filter((peer) => peer.id !== options.self.id);
  const holders = (name: string) => peers.filter((peer) => peer.name?.toLowerCase() === name.toLowerCase());
  if (options.current) {
    const rivals = holders(options.current);
    if (rivals.every((rival) => rival.runtimeFallbackAlias === true && outranks(options.self, rival))) {
      return options.current;
    }
  }
  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? options.base : `${options.base}-${index}`;
    if (holders(candidate).length === 0) return candidate;
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b([A-Za-z0-9_]*(?:key|token|secret|passw(?:or)?d|pwd|credential)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi,
  /[A-Za-z0-9+/_-]{32,}={0,2}/g,
];

/** First line of a prompt, secrets masked, clipped. Published to local peers as "current activity". */
export function summarizeIntent(prompt: string, maxLength = 100): string | undefined {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return undefined;
  let redacted = firstLine;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, key?: string) =>
      typeof key === "string" && match.startsWith(key) ? `${key}=[redacted]` : "[redacted]");
  }
  redacted = redacted.replace(/\s+/g, " ").trim();
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
}

interface SessionManagerLike {
  getEntries?: () => Array<{ type?: string }>;
  getHeader?: () => { titleSource?: string } | null;
}

/**
 * OMP writes a `session_init` entry into every task/subagent session (task
 * executor, /tan clones, persisted revives) before emitting session_start;
 * top-level sessions never have one. Unreadable state fails safe: treated as
 * a subagent so it does not enrol.
 */
export function isSubagentSession(sessionManager: unknown): boolean {
  const manager = sessionManager as SessionManagerLike | undefined;
  if (typeof manager?.getEntries !== "function") return false;
  try {
    return manager.getEntries().some((entry) => entry?.type === "session_init");
  } catch {
    return true;
  }
}

/**
 * OMP stores an auto-generated title in the same slot as a user-chosen name.
 * Only a user-chosen name (/alias, /rename, RPC) is a durable intercom identity;
 * an auto title describes current activity instead.
 */
export function splitSessionName(sessionName: string | undefined, sessionManager: unknown): { explicitName?: string; title?: string } {
  const name = sessionName?.trim();
  if (!name) return {};
  const manager = sessionManager as SessionManagerLike | undefined;
  let source: string | undefined;
  try {
    source = manager?.getHeader?.()?.titleSource;
  } catch {
    source = undefined;
  }
  return source === "auto" ? { title: name } : { explicitName: name };
}

export function terminalHandle(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.ORCA_TERMINAL_HANDLE?.trim() || env.TMUX_PANE?.trim() || undefined;
}

export function buildPeerProfile(input: {
  git?: GitInfo;
  role?: string;
  title?: string;
  intent?: string;
  terminal?: string;
}): PeerProfile {
  return {
    ...optional("repo", input.git?.repo),
    ...optional("worktree", input.git?.worktree),
    ...optional("branch", input.git?.branch),
    ...optional("role", input.role),
    ...optional("title", input.title),
    ...optional("intent", input.intent),
    ...optional("terminal", input.terminal),
  };
}
