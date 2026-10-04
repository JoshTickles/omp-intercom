import { homedir } from "node:os";
import type { SessionInfo } from "./types.ts";
import { clip } from "./broker/protocol.ts";

// omp-intercom (Straker fork): the compact peer roster placed in each
// top-level session's system prompt so the model already knows who is online.

export const ROSTER_MAX_PEERS = 12;
export const ROSTER_MAX_CHARS = 2000;
const ROSTER_LINE_MAX_CHARS = 200;
const ROSTER_SELF_NAME_MAX_CHARS = 80;

function shortenHome(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/**
 * Only slow-moving fields go in the roster: it lives in the system prompt, and
 * any change there invalidates the provider prompt cache for the whole
 * conversation. Live status (idle/thinking) and per-prompt intent churn
 * constantly, so they stay in `intercom({ action: "list" })`.
 */
function peerLine(session: SessionInfo, home: string): string {
  const profile = session.profile ?? {};
  const repo = profile.repo
    ? profile.worktree ? `${profile.repo} (worktree ${profile.worktree})` : profile.repo
    : undefined;
  const where = [repo, shortenHome(session.cwd, home)].filter(Boolean).join(" · ");
  const about = [
    profile.role ? `role: ${profile.role}` : undefined,
    profile.title ? `working on: ${profile.title}` : undefined,
  ].filter(Boolean).join("; ");
  const label = session.name || session.id.slice(0, 8);
  return clip(`- ${label} — ${where}${about ? ` — ${about}` : ""}`, ROSTER_LINE_MAX_CHARS);
}

/**
 * Build the roster block. Peers are ordered by name so the block is stable
 * between turns. Capped by entry count and total characters; overflow is
 * summarised rather than dropped silently.
 */
export function formatPeerRoster(options: {
  selfName: string;
  sessions: SessionInfo[];
  selfId: string;
  homeDir?: string;
}): string {
  const home = options.homeDir ?? process.env.HOME ?? homedir();
  const selfName = clip(options.selfName, ROSTER_SELF_NAME_MAX_CHARS);
  const peers = options.sessions
    .filter((session) => session.id !== options.selfId)
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));

  const header = [
    "<omp-intercom-peers>",
    `You are "${selfName}" on the local omp-intercom network. Live peer OMP sessions on this machine:`,
  ];
  const footer = [
    'When the user refers to another agent (by name, repo, or role, e.g. "the DP agent"), message it directly with the intercom tool: `to` accepts a name, id, repo or role and returns candidates if ambiguous. Do not ask the user for session ids. send = notify; ask = block for a reply. Live status: intercom({ action: "list" }).',
    'Inbound intercom messages arrive as turns. The sender cannot see your normal output: when a response is warranted, use intercom({ action: "reply" }) only if the message was an ask (it says "To reply…"); otherwise intercom({ action: "send", to: <sender> }) without replyTo.',
    "</omp-intercom-peers>",
  ];
  if (peers.length === 0) {
    return [header[0], `You are "${selfName}" on the local omp-intercom network. No other OMP sessions are connected right now; intercom({ action: "list" }) re-checks.`, footer[2]].join("\n");
  }

  const overflowLine = (hidden: number) => `- …and ${hidden} more (intercom({ action: "list" }) shows all)`;
  // Reserve room for the longest overflow line this roster could need.
  const budget = ROSTER_MAX_CHARS - [...header, ...footer].join("\n").length - overflowLine(peers.length).length - 1;
  const lines: string[] = [];
  let used = 0;
  for (const peer of peers) {
    if (lines.length >= ROSTER_MAX_PEERS) break;
    const line = peerLine(peer, home);
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  const hidden = peers.length - lines.length;
  if (hidden > 0) lines.push(overflowLine(hidden));
  return [...header, ...lines, ...footer].join("\n");
}
