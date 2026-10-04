# Changelog

All notable changes to omp-intercom are documented here.

## [Unreleased]

### Fixed
- Installing from GitHub no longer pulls about 950 MB of omp packages. The `@oh-my-pi/*` and `typebox` peers are marked optional, because omp provides them at runtime; an install is now about 12 MB.

### Changed
- Examples the model sees (tool description, roster footer, `/intercom-role` help, bundled skill) use generic names such as `data-pipeline`, "the DP agent" and `reviewer` instead of Straker repo names.
- README rewritten for any omp user: requirements, GitHub install, update, pin and uninstall commands, a quick start, and generic examples throughout.

## [0.2.0-straker.1] - 2026-09-29

Straker fork ([josh-at-straker/omp-intercom](https://github.com/josh-at-straker/omp-intercom)) on top of upstream 0.1.1.

### Added
- Automatic enrolment with stable auto-names for unaliased top-level sessions: the git repo name (linked worktrees use the worktree dir) or the cwd's own name, with `-2`, `-3`… added when sessions share a repo. Only the later starter of a race renames; freed names are never reclaimed mid-session. `/alias` still wins. (`peer-identity.ts`)
- Peer profiles in presence (`repo`, `worktree`, `branch`, `role`, `title`, `intent`), an optional additive protocol field that the broker validates and caps at 160 characters per field. Title and intent are clipped, with credential-looking tokens masked.
- `<omp-intercom-peers>` roster appended to the system prompt in `before_agent_start`: self name plus live peers (name, repo, cwd, role, activity), capped at 12 peers and 2,000 characters. It is replaced per preparation, never persisted or accumulated. (`roster.ts`)
- Role/fuzzy `to` resolution after the exact id, name and id-prefix lookups. It matches against names, repos (including acronyms such as `mf` and joined words such as `modelfactory`), roles and activity. Ties return the candidate list instead of guessing. (`peer-match.ts`)
- `/intercom-role <role|clear>` (persisted per session) and `OMP_INTERCOM_ROLE`.
- Config flags `autoName` and `peerRoster` (both default `true`).
- Broker `sessions` replies carry `mailboxNames`: explicit names of recently disconnected sessions that can still receive queued mail. Additive; older clients ignore it.
- Tests: `peer-identity.test.ts`, `peer-match.test.ts`, `peer-awareness.integration.test.ts`.

### Changed
- OMP auto-generated session titles are no longer used as the intercom name. They are published as activity (`profile.title`). User renames and `/alias` remain explicit identities.
- The intercom tool description and prompt snippet now tell the model to resolve peers itself from the roster and never to ask the user for session ids. The bundled skill documents auto-names and role targeting.
- List rows show the peer's repo, branch, role and activity.
- README rewritten for the fork: the agent-to-agent flow first, then names and targeting, safety, configuration and limits (including that omp and pi agents can't message each other yet).

### Safety
- Auto-names are published as `runtimeFallbackAlias`, so the broker never transfers queued mail by a derived name. Only explicit aliases are mailbox identities.
- Subagent sessions (any session whose history contains OMP's `session_init` entry) never register, get no roster, cannot claim an auto-name, and are refused by the tool. Unreadable state fails safe.
- A name held by an offline explicit session never goes through fuzzy matching, so mail for it is queued instead of delivered to a live peer that resembles it. Auto-names never take such a name either.
- The roster's 2,000-character cap holds in every case: it reserves the real overflow line and clips the session's own name.

## [0.1.1] - 2026-09-07

### Changed
- New omp-intercom banner artwork.
- Release workflow switched to npm trusted publishing (OIDC), no token required.

### Fixed
- Removed `publishConfig.provenance` which broke local `npm publish`.

## [0.1.0] - 2026-09-07

Initial omp release, ported from [pi-intercom](https://github.com/earendil-works/pi-intercom) v0.13.0.

### Changed
- Extension targets the omp API: `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-tui`, `@oh-my-pi/pi-ai` package scopes, `omp` manifest field in `package.json` (with `pi` fallback retained).
- Overlay shortcut moved from Alt+M (reserved by omp) to **Alt+I**.
- Runtime state and config default to `~/.omp/agent/intercom`; `PI_CODING_AGENT_DIR` override retained to match omp's own agent-dir convention.
- Model presence refreshes at `turn_start` because omp has no `model_select` event.
- `StringEnum` tool schemas replaced with plain JSON Schema string enums (omp's `pi-ai` no longer exports `StringEnum`).
- Windows named pipe renamed to `omp-intercom-*`; broker protocol marker renamed to `omp-intercom`.
- Unnamed-session runtime alias prefix renamed from `subagent-chat-*` to `omp-chat-*`.
- Broker auto-spawn runs `broker.ts` directly when the host runtime is Bun; Node + bundled `tsx` remains the default under omp's compiled binary and under pi.
- Test suite runs on `bun test` (was `tsx --test`); `node:test` options converted to `bun:test` equivalents.
- `getAgentDirPath` prefers `$HOME`/`$USERPROFILE` over `os.homedir()` because Bun resolves the passwd entry at process start and ignores later env changes.

### Removed
- `contact_supervisor` tool and the `pi-subagents` bridge (child metadata env, `subagent:control-intercom` / `subagent:result-intercom` relay events). omp subagents coordinate through the built-in Agent Hub.
- Herdr project-pane integration (`openProjectPaneIfMissing`, `focus` params); `cwd` targeting remains for live sessions. `resolveTargetInCwd` moved to `cwd.ts`.
- `defineTool` wrapper — not exported by `@oh-my-pi/pi-coding-agent`; tools are plain objects now.
