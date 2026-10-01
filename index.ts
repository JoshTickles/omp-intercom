import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Text } from "@oh-my-pi/pi-tui";
import { IntercomClient, type SendResult } from "./broker/client.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { SessionListOverlay } from "./ui/session-list.ts";
import { ComposeOverlay, type ComposeResult } from "./ui/compose.ts";
import { InlineMessageComponent } from "./ui/inline-message.ts";
import { getAskTimeoutMs, loadConfig, type IntercomConfig } from "./config.ts";
import { EXTENSION_BUS_FEATURE } from "./types.ts";
import type { Attachment, BrokerMessage, Message, MessageControl, MessageReceiptStatus, PeerProfile, SessionInfo, SessionRegistration } from "./types.ts";
import {
  INTERCOM_EXTENSION_REGISTER_EVENT,
  INTERCOM_EXTENSION_REGISTRY_READY_EVENT,
  INTERCOM_OUTBOX_REQUEST_EVENT,
  INTERCOM_OUTBOX_RESULT_EVENT,
  type IntercomExtensionChannel,
  type IntercomExtensionEvent,
  type IntercomExtensionOwner,
  type IntercomExtensionRegistration,
  type IntercomExtensionState,
  type IntercomOutboxRequestV1,
  type IntercomOutboxResultCode,
  type IntercomOutboxResultStatus,
  type IntercomOutboxResultV1,
} from "./extension-api.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import { resolve as resolvePath } from "node:path";
import { sameCwd, resolveTargetInCwd } from "./cwd.ts";
import { formatContextUsage } from "./format-context.ts";
import {
  derivePeerBaseName,
  isSubagentSession,
  readGitInfo,
  reconcileAutoName,
  splitSessionName,
  summarizeIntent,
  type GitInfo,
} from "./peer-identity.ts";
import { PEER_PROFILE_FIELD_MAX_LENGTH } from "./broker/protocol.ts";
import { matchPeer, type PeerMatchCandidate } from "./peer-match.ts";
import { formatPeerRoster } from "./roster.ts";

const INTERCOM_TOOL_NAME = "intercom";
const INBOUND_MESSAGE_DEDUPE_MAX = 1000;
const INBOUND_MESSAGE_DEDUPE_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "omp-chat";

// omp's pi-ai no longer exports StringEnum; emit the same JSON Schema shape
// ({ type: "string", enum: [...] }) for tool parameter enums.
function stringEnum<T extends string>(values: readonly T[], options?: Record<string, unknown>) {
  return Type.Unsafe<T>({ type: "string", enum: [...values], ...(options ?? {}) });
}
const INTERCOM_SESSION_ID_ENV = "PI_INTERCOM_SESSION_ID";
const STABLE_INTERCOM_SESSION_ID_ENV = "PI_INTERCOM_STABLE_ID";
const NAME_POLL_MS_ENV = "PI_INTERCOM_NAME_POLL_MS";
const ROLE_ENV = "OMP_INTERCOM_ROLE";
const ROLE_ENTRY_TYPE = "omp-intercom.role";
const ROSTER_CONNECT_TIMEOUT_MS = 3000;
const ROSTER_LIST_TIMEOUT_MS = 1500;

/** A fuzzy target matched several live peers equally well; the caller must pick one. */
class AmbiguousPeerError extends Error {
  constructor(query: string, readonly candidates: PeerMatchCandidate[], prefixes: Map<string, string>) {
    super(`"${query}" matches ${candidates.length} peers equally well; pick one by name or id:\n${candidates
      .map(({ session }) => {
        const profile = session.profile ?? {};
        const about = [profile.repo, profile.role ? `role: ${profile.role}` : undefined, profile.title ?? profile.intent]
          .filter(Boolean)
          .join(" · ");
        return `- ${session.name ?? "unnamed"} (${prefixes.get(session.id) ?? session.id.slice(0, 8)}) — ${session.cwd}${about ? ` — ${about}` : ""}`;
      })
      .join("\n")}`);
  }
}

interface InboundMessageEntry {
  from: SessionInfo;
  message: Message;
  replyCommand?: string;
  bodyText: string;
}

interface DeliveryTarget {
  id: string;
  label: string;
}

interface OutboxTarget {
  id: string;
  label: string;
}

interface OutboxRequestTrace {
  requestId: string;
  extensionId?: string;
  extensionName?: string;
  to?: string;
  message?: string;
}

interface PendingOutboxRequest {
  generation: number;
  request: OutboxRequestTrace;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deliveryDetails(result: SendResult): Record<string, unknown> {
  return {
    messageId: result.id,
    delivered: result.delivered,
    delivery: result.delivery,
    retryable: result.retryable,
    outcomeKnown: result.outcomeKnown,
    ...(result.code ? { code: result.code } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatAttachments(attachments: Attachment[]): string {
  let text = "";
  for (const att of attachments) {
    if (att.language) {
      text += `\n\n---\nAttachment: ${att.name}\n~~~${att.language}\n${att.content}\n~~~`;
    } else {
      text += `\n\n---\nAttachment: ${att.name}\n${att.content}`;
    }
  }
  return text;
}
function duplicateSessionNames(sessions: SessionInfo[]): Set<string> {
  return new Set(
    sessions
      .map(s => s.name?.toLowerCase())
      .filter((name): name is string => Boolean(name))
      .filter((name, index, names) => names.indexOf(name) !== index)
  );
}
function sessionIdPrefixes(sessions: SessionInfo[]): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (const session of sessions) {
    let longestSharedPrefix = 0;
    for (const other of sessions) {
      if (other.id === session.id) {
        continue;
      }
      let length = 0;
      while (length < session.id.length && session.id[length] === other.id[length]) {
        length += 1;
      }
      longestSharedPrefix = Math.max(longestSharedPrefix, length);
    }
    const minimumLength = Math.max(8, longestSharedPrefix + 1);
    const groupBoundary = session.id.indexOf("-", minimumLength);
    const length = groupBoundary === -1 ? minimumLength : groupBoundary;
    prefixes.set(session.id, session.id.slice(0, length));
  }
  return prefixes;
}
function parseOutboxRequestPayload(payload: unknown): { ok: true; request: IntercomOutboxRequestV1 } | { ok: false; requestId?: string; extensionId?: string; extensionName?: string; detail: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, detail: "request must be an object" };
  }
  const record = payload as Record<string, unknown>;
  const requestId = typeof record.requestId === "string" && record.requestId.trim() ? record.requestId : undefined;
  const extensionId = typeof record.extensionId === "string" && record.extensionId.trim() ? record.extensionId.trim() : undefined;
  const extensionName = typeof record.extensionName === "string" && record.extensionName.trim() ? record.extensionName.trim() : undefined;
  if (record.version !== 1) {
    return { ok: false, requestId, extensionId, extensionName, detail: "version must be 1" };
  }
  if (!requestId) {
    return { ok: false, extensionId, extensionName, detail: "requestId is required" };
  }
  if (!extensionId) {
    return { ok: false, requestId, extensionName, detail: "extensionId is required" };
  }
  if (!extensionName) {
    return { ok: false, requestId, extensionId, detail: "extensionName is required" };
  }
  if (typeof record.to !== "string" || !record.to.trim()) {
    return { ok: false, requestId, extensionId, extensionName, detail: "to is required" };
  }
  if (typeof record.message !== "string" || !record.message.trim()) {
    return { ok: false, requestId, extensionId, extensionName, detail: "message is required" };
  }
  return {
    ok: true,
    request: {
      version: 1,
      requestId,
      extensionId,
      extensionName,
      to: record.to.trim(),
      message: record.message,
    },
  };
}
function runtimeFallbackAliasFor(sessionId: string): string {
  const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalizedSessionId.slice(0, 18)}`;
}
/**
 * Presence identity. An explicit alias (/alias, /rename) always wins and is a
 * durable mailbox identity. Otherwise the session presents its derived
 * auto-name (or the upstream `omp-chat-<id>` fallback when auto-naming is off
 * or not yet reconciled). Both non-explicit forms are flagged
 * runtimeFallbackAlias so the broker never transfers queued mail by them.
 */
function buildPresenceIdentity(pi: ExtensionAPI, sessionId: string, sessionManager: unknown, autoName: string | null): { name: string; runtimeFallbackAlias: boolean } {
  const { explicitName } = splitSessionName(pi.getSessionName(), sessionManager);
  if (explicitName) {
    return { name: explicitName, runtimeFallbackAlias: false };
  }
  return { name: autoName ?? runtimeFallbackAliasFor(sessionId), runtimeFallbackAlias: true };
}
function resolveConfiguredIntercomSessionId(piSessionId: string, config: IntercomConfig): string {
  return process.env[STABLE_INTERCOM_SESSION_ID_ENV]?.trim() || config.stableId || piSessionId;
}
// The tmux pane id (e.g. "%212") the session was launched in. $TMUX_PANE is
// inherited at process start and immutable for the lifetime — moving the pane
// between windows keeps its id — so it is a stable join key a peer can use to
// live-resolve the current window via tmux. Absent outside tmux.
function currentTmuxPane(): string | undefined {
  const pane = process.env.TMUX_PANE?.trim();
  return pane ? pane : undefined;
}
function formatIntercomContactSnippet(sessionId: string): string {
  return `Use omp-intercom: intercom({ action: "send", to: "${sessionId}", message: "..." })`;
}
function formatSessionLabel(session: SessionInfo, duplicates: Set<string>): string {
  if (!session.name) {
    return session.id;
  }
  return duplicates.has(session.name.toLowerCase())
    ? `${session.name} (${session.id.slice(0, 8)})`
    : session.name;
}
function formatSessionListRow(session: SessionInfo, currentCwd: string, isSelf: boolean, idPrefix: string): string {
  const name = session.name || "Unnamed session";
  const tags = [isSelf ? "self" : session.cwd === currentCwd ? "same cwd" : undefined, session.status]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  const pane = session.tmuxPane ? ` · tmux ${session.tmuxPane}` : "";
  const profile = session.profile ?? {};
  const about = [
    profile.repo ? `repo ${profile.worktree ? `${profile.repo}/${profile.worktree}` : profile.repo}${profile.branch ? `@${profile.branch}` : ""}` : undefined,
    profile.role ? `role: ${profile.role}` : undefined,
    profile.title ? `working on: ${profile.title}` : profile.intent ? `last ask: ${profile.intent}` : undefined,
  ].filter(Boolean).join(" · ");
  return `• ${name} (${idPrefix}) — ${session.cwd} (${session.model}${formatContextUsage(session)}${pane})${suffix}${about ? `\n    ${about}` : ""}`;
}
function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
function firstTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text?.replace(/\*\*/g, "") ?? "";
}
function formatMessageTimestamp(timestamp: number | undefined): string | undefined {
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}
function formatInboundDeliveryMetadata(message: Message): string {
  const parts = [`id ${message.id}`];
  if (typeof message.senderSequence === "number") parts.push(`seq ${message.senderSequence}`);
  if (message.supersedes) parts.push(`supersedes ${message.supersedes}`);
  if (message.retryOf) parts.push(`retry of ${message.retryOf}`);
  const sentAt = formatMessageTimestamp(message.timestamp);
  if (sentAt) parts.push(`sent ${sentAt}`);
  const brokerDeliveredAt = formatMessageTimestamp(message.brokerDeliveredAt);
  if (brokerDeliveredAt) parts.push(`broker delivered ${brokerDeliveredAt}`);
  const receiverReceivedAt = formatMessageTimestamp(message.receiverReceivedAt);
  if (receiverReceivedAt) parts.push(`receiver received ${receiverReceivedAt}`);
  const injectedAt = formatMessageTimestamp(message.injectedAt);
  if (injectedAt) parts.push(`injected ${injectedAt}`);
  return parts.join(" · ");
}
function getNamePollMs(): number {
  const configured = process.env[NAME_POLL_MS_ENV];
  if (configured !== undefined) {
    const value = Number(configured);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 1000;
}
export default function piIntercomExtension(pi: ExtensionAPI) {
  let client: IntercomClient | null = null;
  const config: IntercomConfig = loadConfig();
  const askTimeoutMs = getAskTimeoutMs();
  const localExtensions = new Map<string, {
    registration: IntercomExtensionRegistration;
    channel: IntercomExtensionChannel;
    owner?: IntercomExtensionOwner;
    state?: IntercomExtensionState;
  }>();
  let runtimeContext: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  let currentIntercomSessionId: string | null = null;
  let currentModel = "unknown";
  let sessionStartedAt: number | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let namePollTimer: NodeJS.Timeout | null = null;
  let lastPresenceKey: string | null = null;
  const previousIntercomSessionId = process.env[INTERCOM_SESSION_ID_ENV];
  let reconnectPromise: Promise<IntercomClient> | null = null;
  let reconnectPromiseGeneration: number | null = null;
  let startupConnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let shuttingDown = false;
  let disposed = true;
  let runtimeStarted = false;
  let runtimeGeneration = 0;
  let agentRunning = false;
  const activeTools = new Map<string, string>();
  const replyTracker = new ReplyTracker();
  // omp-intercom (Straker fork) peer identity + awareness state.
  let autoName: string | null = null;
  let autoNameBase: string | null = null;
  let gitInfo: GitInfo | undefined;
  let latestIntent: string | undefined;
  let role: string | undefined;
  let knownSessions: SessionInfo[] = [];

  const seenInboundMessages = new Map<string, number>();
  const latestOutboundReceipts = new Map<string, { status: MessageReceiptStatus; timestamp: number; detail?: string }>();
  const outboxRequestIds = new Set<string>();
  const pendingOutboxRequests = new Map<string, PendingOutboxRequest>();
  function dismissIncomingAsk(messageId: string): void {
    replyTracker.dismissPendingAsk(messageId);
  }
  function hasSeenInboundMessage(from: SessionInfo, message: Message, now = Date.now()): boolean {
    for (const [key, seenAt] of seenInboundMessages) {
      if (now - seenAt > INBOUND_MESSAGE_DEDUPE_RETENTION_MS) {
        seenInboundMessages.delete(key);
      }
    }
    const key = `${from.id}\0${message.id}`;
    if (seenInboundMessages.has(key)) {
      return true;
    }
    seenInboundMessages.set(key, now);
    while (seenInboundMessages.size > INBOUND_MESSAGE_DEDUPE_MAX) {
      const oldestKey = seenInboundMessages.keys().next().value;
      if (typeof oldestKey !== "string") break;
      seenInboundMessages.delete(oldestKey);
    }
    return false;
  }
  function emitMessageReceipt(messageId: string, status: MessageReceiptStatus, detail?: string): void {
    try {
      client?.sendMessageReceipt({
        messageId,
        status,
        timestamp: Date.now(),
        ...(detail ? { detail } : {}),
      });
    } catch {
      // Receipts are diagnostics; message handling should not fail when the sender disconnects.
    }
  }
  function handleMessageControl(control: MessageControl): void {
    replyTracker.dismissPendingAsk(control.messageId);
    if (control.action === "cancel") {
      emitMessageReceipt(control.messageId, "cancellation_requested", "message may already be injected or processed");
      return;
    }
    emitMessageReceipt(control.messageId, "superseded", control.supersededBy ? `superseded by ${control.supersededBy}` : undefined);
  }
  function latestDeliveryState(messageId: string | null, fallback: string): string {
    if (!messageId) {
      return fallback;
    }
    const receipt = latestOutboundReceipts.get(messageId);
    return receipt ? receipt.status : fallback;
  }
  let replyWaiter: {
    from: string;
    replyTo: string;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  } | null = null;
  function waitForReply(from: string, replyTo: string, signal?: AbortSignal, cancelOnAbort?: () => void, getDeliveryState: () => string = () => "unknown"): Promise<Message> {
    if (replyWaiter) {
      return Promise.reject(new Error("Already waiting for a reply"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Cancelled"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const timeoutDescription = askTimeoutMs % 60000 === 0 ? `${askTimeoutMs / 60000} minutes` : `${askTimeoutMs}ms`;
        rejectReplyWaiter(new Error(`No reply from "${from}" for message ${replyTo} within ${timeoutDescription}. Last known delivery state: ${getDeliveryState()}. This waiter timeout is not cancellation; the delivered message may still be queued or actionable in the recipient session.`));
      }, askTimeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (replyWaiter?.replyTo === replyTo) {
          replyWaiter = null;
        }
      };
      const onAbort = () => {
        cancelOnAbort?.();
        cleanup();
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      replyWaiter = {
        from,
        replyTo,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
  }
  function rejectReplyWaiter(error: Error): void {
    replyWaiter?.reject(error);
  }
  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  function clearStartupConnectTimer(): void {
    if (!startupConnectTimer) {
      return;
    }
    clearTimeout(startupConnectTimer);
    startupConnectTimer = null;
  }
  function clearNamePollTimer(): void {
    if (!namePollTimer) {
      return;
    }
    clearInterval(namePollTimer);
    namePollTimer = null;
  }
  function getLiveContext(ctx: ExtensionContext | null = runtimeContext, generation = runtimeGeneration): ExtensionContext | null {
    if (disposed || shuttingDown || generation !== runtimeGeneration || !ctx) {
      return null;
    }
    try {
      if (currentSessionId && ctx.sessionManager.getSessionId() !== currentSessionId) {
        return null;
      }
      void ctx.hasUI;
      return ctx;
    } catch {
      // A context that throws while reading session/UI state is no longer usable.
      return null;
    }
  }
  function notifyIfLive(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation = runtimeGeneration): void {
    const liveContext = getLiveContext(ctx, generation);
    if (!liveContext?.hasUI) {
      return;
    }
    try {
      liveContext.ui.notify(message, level);
    } catch {
      // The UI can disappear during session shutdown/reload while async overlay work is settling.
    }
  }
  function notifyAliasCommand(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation = runtimeGeneration): void {
    const liveContext = getLiveContext(ctx, generation);
    if (!liveContext) return;
    if (!liveContext.hasUI) {
      // Command handlers return void and print mode supplies a no-op UI. Keep
      // alias guidance visible without injecting a synthetic Pi message.
      console.error(message);
      return;
    }
    notifyIfLive(liveContext, message, level, generation);
  }
  function getReconnectDelayMs(): number {
    const backoffMs = [1000, 2000, 5000, 10000, 30000];
    return backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)]!;
  }
  function currentStatus(): string {
    const activeToolName = activeTools.values().next().value;
    const lifecycleStatus = activeToolName ? `tool:${activeToolName}` : agentRunning ? "thinking" : "idle";
    return config.status ? `${lifecycleStatus} · ${config.status}` : lifecycleStatus;
  }
  function emitLocalExtensionEvent(namespace: string, event: IntercomExtensionEvent): void {
    try {
      localExtensions.get(namespace)?.registration.onEvent(event);
    } catch {
      // One local extension must not break intercom or other extension channels.
    }
  }
  function createExtensionChannel(namespace: string): IntercomExtensionChannel {
    return {
      namespace,
      snapshot() {
        const extension = localExtensions.get(namespace);
        return {
          connected: Boolean(client?.isConnected()),
          supported: Boolean(client?.supportsFeature(EXTENSION_BUS_FEATURE)),
          ...(extension?.owner ? { owner: extension.owner } : {}),
          ...(extension?.state ? { state: extension.state } : {}),
        };
      },
      publish(payload, options = {}) {
        const activeClient = client;
        if (!activeClient?.isConnected()) throw new Error("Intercom is not connected");
        const extension = localExtensions.get(namespace);
        const ownerOnly = options.ownerOnly ?? false;
        const ownerEpoch = ownerOnly ? extension?.owner?.epoch : undefined;
        if (ownerOnly && !ownerEpoch) throw new Error(`No owner is available for ${namespace}`);
        activeClient.sendExtensionMessage({
          type: "extension_publish",
          namespace,
          audience: options.audience ?? "owner",
          ...(ownerOnly ? { ownerOnly: true, ownerEpoch } : {}),
          payload,
        });
      },
      commitState(payload, expectedRevision) {
        const activeClient = client;
        if (!activeClient?.isConnected()) throw new Error("Intercom is not connected");
        const extension = localExtensions.get(namespace);
        const ownerEpoch = extension?.owner?.epoch;
        if (!ownerEpoch || extension.owner?.sessionId !== activeClient.sessionId) {
          throw new Error(`Current session is not the owner of ${namespace}`);
        }
        activeClient.sendExtensionMessage({
          type: "extension_state_commit",
          namespace,
          ownerEpoch,
          expectedRevision: expectedRevision ?? extension.state?.revision ?? 0,
          payload,
        });
      },
      async listSessions() {
        const activeClient = client;
        if (!activeClient?.isConnected()) throw new Error("Intercom is not connected");
        return activeClient.listSessions();
      },
    };
  }
  function currentExtensionCapabilities() {
    return [...localExtensions.values()].map(({ registration }) => ({
      namespace: registration.namespace,
      ownerEligible: registration.ownerEligible,
    }));
  }
  function registerLocalExtension(registration: IntercomExtensionRegistration): void {
    if (!/^[a-z0-9][a-z0-9._/-]{0,63}$/.test(registration.namespace)) {
      throw new Error(`Invalid intercom extension namespace: ${registration.namespace}`);
    }
    if (localExtensions.has(registration.namespace)) {
      throw new Error(`Intercom extension namespace already registered: ${registration.namespace}`);
    }
    const channel = createExtensionChannel(registration.namespace);
    localExtensions.set(registration.namespace, { registration, channel });
    const activeClient = client;
    const connected = Boolean(activeClient?.isConnected());
    const supported = Boolean(activeClient?.supportsFeature(EXTENSION_BUS_FEATURE));
    // Write the capability update before exposing a connected channel. Socket
    // framing preserves this order if onReady publishes synchronously.
    if (activeClient && connected && supported) {
      activeClient.updateExtensionCapabilities(currentExtensionCapabilities());
    }
    registration.onReady(channel);
    if (connected) {
      emitLocalExtensionEvent(registration.namespace, { type: "connection", connected: true, supported });
    }
  }
  function buildRegistration(): SessionRegistration {
    const liveContext = getLiveContext();
    if (!liveContext || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }

    const identity = currentIdentity();
    const tmuxPane = currentTmuxPane();
    return {
      ...identity,
      profile: currentProfile(),
      cwd: liveContext.cwd,
      model: currentModel,
      pid: process.pid,
      startedAt: sessionStartedAt,
      lastActivity: Date.now(),
      status: currentStatus(),
      ...(tmuxPane ? { tmuxPane } : {}),
      ...(localExtensions.size > 0
        ? {
            extensions: currentExtensionCapabilities(),
          }
        : {}),
    };
  }
  // Snapshot the live session's context-window usage for presence. getContextUsage()
  // (stock SDK) reports { tokens, contextWindow, percent }, with tokens/percent null
  // right after a compaction (before the next assistant response). We emit null in
  // that case to CLEAR a peer's stale value rather than freeze the old percentage.
  // Feature-detected so an older runtime without getContextUsage() just omits it.
  function currentContextUsage(): { contextPct?: number | null; contextTokens?: number | null; contextWindow?: number } {
    const usage = getLiveContext()?.getContextUsage?.();
    if (!usage) {
      return {};
    }
    const result: { contextPct?: number | null; contextTokens?: number | null; contextWindow?: number } = {
      contextPct: typeof usage.percent === "number" && Number.isFinite(usage.percent) ? Math.round(usage.percent) : null,
      contextTokens: typeof usage.tokens === "number" && Number.isFinite(usage.tokens) ? usage.tokens : null,
    };
    if (typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
      result.contextWindow = usage.contextWindow;
    }
    return result;
  }

  function currentIdentity(): { name: string; runtimeFallbackAlias: boolean } {
    const sessionId = currentIntercomSessionId ?? currentSessionId ?? "";
    return buildPresenceIdentity(pi, sessionId, getLiveContext()?.sessionManager, autoName);
  }
  function currentProfile(): PeerProfile {
    const { title } = splitSessionName(pi.getSessionName(), getLiveContext()?.sessionManager);
    // The auto title reaches every peer's system prompt, so it gets the same redaction as intent.
    // Empty fields are dropped by JSON framing and the broker's normalizePeerProfile.
    return {
      repo: gitInfo?.repo,
      worktree: gitInfo?.worktree,
      branch: gitInfo?.branch,
      role,
      title: title ? summarizeIntent(title, PEER_PROFILE_FIELD_MAX_LENGTH) : undefined,
      intent: latestIntent,
    };
  }
  function presenceKey(identity: { name: string; runtimeFallbackAlias: boolean }, profile: PeerProfile): string {
    return JSON.stringify({ ...identity, profile });
  }
  function syncPresenceIdentity(): void {
    if (!client || !getLiveContext()) {
      return;
    }
    const identity = currentIdentity();
    const profile = currentProfile();
    lastPresenceKey = presenceKey(identity, profile);
    client.updatePresence({ ...identity, profile, model: currentModel, status: currentStatus(), ...currentContextUsage() });
  }
  /** Keep this session's derived name unique among live peers and offline mailboxes (see reconcileAutoName). */
  function reconcileOwnAutoName(): void {
    const selfId = client?.sessionId;
    if (!config.autoName || !autoNameBase || !selfId || sessionStartedAt === null || !getLiveContext()) {
      return;
    }
    if (splitSessionName(pi.getSessionName(), getLiveContext()?.sessionManager).explicitName) {
      return;
    }
    const next = reconcileAutoName({
      base: autoNameBase,
      ...(autoName ? { current: autoName } : {}),
      self: { id: selfId, startedAt: sessionStartedAt },
      peers: knownSessions,
      reserved: client?.mailboxNames ?? [],
    });
    if (next !== autoName) {
      autoName = next;
      syncPresenceIdentity();
    }
  }
  function rememberSession(session: SessionInfo): void {
    knownSessions = [...knownSessions.filter((known) => known.id !== session.id), session];
    reconcileOwnAutoName();
  }
  async function refreshKnownSessions(activeClient: IntercomClient, timeoutMs?: number): Promise<SessionInfo[]> {
    const sessions = await activeClient.listSessions(timeoutMs ? { timeoutMs } : {});
    if (client === activeClient) {
      knownSessions = sessions;
      reconcileOwnAutoName();
    }
    return sessions;
  }
  function startNamePoll(): void {
    clearNamePollTimer();
    lastPresenceKey = null;
    namePollTimer = setInterval(() => {
      if (!currentSessionId || !getLiveContext()) {
        return;
      }
      if (presenceKey(currentIdentity(), currentProfile()) !== lastPresenceKey) {
        syncPresenceIdentity();
      }
    }, getNamePollMs());
    namePollTimer.unref?.();
  }
  function publishIntercomSessionId(sessionId: string): void {
    process.env[INTERCOM_SESSION_ID_ENV] = sessionId;
  }
  function restoreIntercomSessionId(): void {
    if (previousIntercomSessionId === undefined) {
      delete process.env[INTERCOM_SESSION_ID_ENV];
      return;
    }
    process.env[INTERCOM_SESSION_ID_ENV] = previousIntercomSessionId;
  }
  function syncPresenceStatus(): void {
    if (!client || !currentSessionId || !getLiveContext()) {
      return;
    }
    // context% rides the status heartbeat so peers see live usage at turn boundaries.
    client.updatePresence({ status: currentStatus(), ...currentContextUsage() });
  }
  function buildOutboxResult(request: OutboxRequestTrace, status: IntercomOutboxResultStatus, options: {
    code?: IntercomOutboxResultCode;
    detail?: string;
    messageId?: string;
  } = {}): IntercomOutboxResultV1 {
    return {
      version: 1,
      requestId: request.requestId,
      status,
      ...(options.code ? { code: options.code } : {}),
      ...(request.extensionId ? { extensionId: request.extensionId } : {}),
      ...(request.extensionName ? { extensionName: request.extensionName } : {}),
      ...(options.messageId ? { messageId: options.messageId } : {}),
      ...(options.detail ? { detail: options.detail } : {}),
    };
  }
  function emitOutboxResult(result: IntercomOutboxResultV1, request: OutboxRequestTrace): void {
    pi.appendEntry("intercom_outbox_result", {
      ...result,
      ...(request.to ? { to: request.to } : {}),
      ...(request.message ? { message: { text: request.message } } : {}),
      timestamp: Date.now(),
    });
    pi.events.emit(INTERCOM_OUTBOX_RESULT_EVENT, result);
  }
  function settleOutboxRequest(requestId: string, status: IntercomOutboxResultStatus, options: {
    code?: IntercomOutboxResultCode;
    detail?: string;
    messageId?: string;
  } = {}): boolean {
    const pending = pendingOutboxRequests.get(requestId);
    if (!pending) {
      return false;
    }
    pendingOutboxRequests.delete(requestId);
    emitOutboxResult(buildOutboxResult(pending.request, status, options), pending.request);
    return true;
  }
  function failPendingOutboxRequests(generation: number, code: IntercomOutboxResultCode, detail: string): void {
    for (const [requestId, pending] of [...pendingOutboxRequests]) {
      if (pending.generation === generation) {
        settleOutboxRequest(requestId, "failed", { code, detail });
      }
    }
  }
  function resolveOutboxTarget(sessions: SessionInfo[], currentId: string, to: string): { ok: true; target: OutboxTarget } | { ok: false; code: "target_not_found" | "target_ambiguous" | "self_target"; detail: string } {
    const byId = sessions.find((session) => session.id === to);
    const lowerName = to.toLowerCase();
    const byName = byId ? [] : sessions.filter((session) => session.name?.toLowerCase() === lowerName);
    const byPrefix = byId || byName.length > 0 ? [] : sessions.filter((session) => session.id.startsWith(to));
    const matches = byId ? [byId] : byName.length > 0 ? byName : byPrefix;
    if (matches.length === 0) {
      return { ok: false, code: "target_not_found", detail: `Session "${to}" is not currently connected.` };
    }
    if (matches.length > 1) {
      return { ok: false, code: "target_ambiguous", detail: `Multiple sessions match "${to}".` };
    }
    const target = matches[0]!;
    if (target.id === currentId) {
      return { ok: false, code: "self_target", detail: "Cannot message the current session." };
    }
    return { ok: true, target: { id: target.id, label: target.name || target.id } };
  }
  function handleOutboxRequest(payload: unknown): void {
    const parsed = parseOutboxRequestPayload(payload);
    if (parsed.ok === false) {
      if (parsed.requestId) {
        const trace: OutboxRequestTrace = {
          requestId: parsed.requestId,
          ...(parsed.extensionId ? { extensionId: parsed.extensionId } : {}),
          ...(parsed.extensionName ? { extensionName: parsed.extensionName } : {}),
        };
        emitOutboxResult(buildOutboxResult(trace, "rejected", { code: "invalid_request", detail: parsed.detail }), trace);
      }
      return;
    }

    const request = parsed.request;
    const trace: OutboxRequestTrace = {
      requestId: request.requestId,
      extensionId: request.extensionId,
      extensionName: request.extensionName,
      to: request.to,
      message: request.message,
    };
    if (outboxRequestIds.has(request.requestId)) {
      emitOutboxResult(buildOutboxResult(trace, "rejected", { code: "duplicate_request", detail: "requestId has already been used in this session runtime" }), trace);
      return;
    }
    outboxRequestIds.add(request.requestId);

    const outboxGeneration = runtimeGeneration;
    pendingOutboxRequests.set(request.requestId, { generation: outboxGeneration, request: trace });

    void (async () => {
      const liveContext = getLiveContext(runtimeContext, outboxGeneration);
      if (!liveContext) {
        settleOutboxRequest(request.requestId, "failed", { code: "session_unavailable", detail: "Intercom session is not active" });
        return;
      }
      if (config.confirmSend && !liveContext.hasUI) {
        settleOutboxRequest(request.requestId, "blocked", { code: "confirmation_unavailable", detail: "confirmSend is enabled but no UI is available" });
        return;
      }

      let activeClient: IntercomClient;
      try {
        activeClient = await ensureConnected("background");
      } catch (error) {
        settleOutboxRequest(request.requestId, "failed", { code: "session_unavailable", detail: getErrorMessage(error) });
        return;
      }
      if (!getLiveContext(liveContext, outboxGeneration)) {
        settleOutboxRequest(request.requestId, "failed", { code: "session_ended", detail: "Session ended before target resolution" });
        return;
      }

      let target: OutboxTarget;
      try {
        const currentClientSessionId = activeClient.sessionId;
        const sessions = await activeClient.listSessions();
        if (!currentClientSessionId) {
          settleOutboxRequest(request.requestId, "failed", { code: "session_unavailable", detail: "Current session is not registered with intercom" });
          return;
        }
        const resolved = resolveOutboxTarget(sessions, currentClientSessionId, request.to);
        if (resolved.ok === false) {
          settleOutboxRequest(request.requestId, "blocked", { code: resolved.code, detail: resolved.detail });
          return;
        }
        target = resolved.target;
      } catch (error) {
        settleOutboxRequest(request.requestId, "failed", { code: "session_unavailable", detail: getErrorMessage(error) });
        return;
      }
      if (!getLiveContext(liveContext, outboxGeneration)) {
        settleOutboxRequest(request.requestId, "failed", { code: "session_ended", detail: "Session ended before confirmation" });
        return;
      }

      if (config.confirmSend) {
        let confirmed = false;
        try {
          confirmed = await liveContext.ui.confirm(
            "Send extension message",
            `Allow ${request.extensionName} (${request.extensionId}) to send to "${target.label}":\n\n${request.message}`,
          );
        } catch (error) {
          settleOutboxRequest(request.requestId, "blocked", { code: "confirmation_unavailable", detail: getErrorMessage(error) });
          return;
        }
        if (!getLiveContext(liveContext, outboxGeneration)) {
          settleOutboxRequest(request.requestId, "failed", { code: "session_ended", detail: "Session ended during confirmation" });
          return;
        }
        if (!confirmed) {
          settleOutboxRequest(request.requestId, "rejected", { code: "user_cancelled", detail: "User cancelled the outbox request" });
          return;
        }
      }

      try {
        if (!getLiveContext(liveContext, outboxGeneration) || client !== activeClient || !activeClient.isConnected()) {
          settleOutboxRequest(request.requestId, "failed", { code: "session_ended", detail: "Session ended before delivery" });
          return;
        }
        const result = await activeClient.send(target.id, {
          messageId: request.requestId,
          text: request.message,
          provenance: {
            type: "extension_outbox",
            extensionId: request.extensionId,
            extensionName: request.extensionName,
            requestId: request.requestId,
          },
        });
        if (!getLiveContext(liveContext, outboxGeneration)) {
          settleOutboxRequest(request.requestId, "failed", { code: "session_ended", detail: "Session ended during delivery" });
          return;
        }
        if (!result.delivered) {
          settleOutboxRequest(request.requestId, "failed", { code: "delivery_failed", messageId: result.id, detail: result.reason ?? "Delivery failed" });
          return;
        }
        pi.appendEntry("intercom_sent", {
          to: target.label,
          message: { text: request.message },
          messageId: result.id,
          timestamp: Date.now(),
          extension: { id: request.extensionId, name: request.extensionName, requestId: request.requestId },
        });
        settleOutboxRequest(request.requestId, "sent", { messageId: result.id });
      } catch (error) {
        const live = getLiveContext(liveContext, outboxGeneration);
        settleOutboxRequest(request.requestId, "failed", {
          code: live ? "session_unavailable" : "session_ended",
          detail: getErrorMessage(error),
        });
      }
    })();
  }
  function shouldTriggerInboundMessage(entry: InboundMessageEntry, forceTrigger = false): boolean {
    if (forceTrigger) {
      return true;
    }
    if (config.inboundTrigger === "always") {
      return true;
    }
    if (config.inboundTrigger === "replies") {
      return Boolean(entry.message.replyTo);
    }
    return false;
  }
  function sendIncomingMessage(entry: InboundMessageEntry, delivery: "trigger" | "steer", generation = runtimeGeneration, forceTrigger = false): void {
    if (runtimeStarted && !getLiveContext(runtimeContext, generation)) {
      return;
    }
    const injectedMessage = { ...entry.message, injectedAt: Date.now() };
    emitMessageReceipt(injectedMessage.id, "injected");
    const replyCommand = delivery === "steer" && entry.replyCommand && entry.message.expectsReply
      ? `intercom({ action: "reply", replyTo: ${JSON.stringify(entry.message.id)}, message: "..." })`
      : entry.replyCommand;
    const deliveredEntry = { ...entry, message: injectedMessage, replyCommand };
    replyTracker.queueTurnContext({ from: entry.from, message: injectedMessage, receivedAt: Date.now() });
    const senderDisplay = entry.from.name || entry.from.id.slice(0, 8);
    const replyInstruction = replyCommand ? `\n\nTo reply, use the intercom tool: ${replyCommand}` : "";
    const deliveryMetadata = formatInboundDeliveryMetadata(injectedMessage);
    pi.sendMessage(
      {
        customType: "intercom_message",
        content: `**From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n_${deliveryMetadata}_\n\n${entry.bodyText}`,
        display: true,
        details: deliveredEntry,
      },
      delivery === "trigger" && shouldTriggerInboundMessage(entry, forceTrigger)
        ? { triggerTurn: true }
        : { deliverAs: "steer" }
    );
  }
  function sendIncomingBrokerMessage(entry: InboundMessageEntry, delivery: "trigger" | "steer", generation = runtimeGeneration): void {
    sendIncomingMessage(entry, delivery, generation);
  }
  function handleIncomingMessage(ctx: ExtensionContext, from: SessionInfo, message: Message): void {
    const messageGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, messageGeneration);
    if (!liveContext) {
      return;
    }
    const receiverReceivedAt = Date.now();
    if (hasSeenInboundMessage(from, message, receiverReceivedAt)) {
      emitMessageReceipt(message.id, "acknowledged", "duplicate message id suppressed");
      return;
    }
    const receivedMessage = { ...message, receiverReceivedAt };
    emitMessageReceipt(receivedMessage.id, "receiver_received");
    if (replyWaiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === replyWaiter.from.toLowerCase()
        || from.id === replyWaiter.from;
      const replyMatches = receivedMessage.replyTo === replyWaiter.replyTo;
      if (fromMatches && replyMatches) {
        emitMessageReceipt(receivedMessage.id, "acknowledged", "matched reply waiter");
        replyWaiter.resolve(receivedMessage);
        return;
      }
    }
    const attachmentText = receivedMessage.content.attachments?.length
      ? formatAttachments(receivedMessage.content.attachments)
      : "";
    const bodyText = `${receivedMessage.content.text}${attachmentText}`;
    const replyCommand = config.replyHint && receivedMessage.expectsReply
      ? `intercom({ action: "reply", message: "..." })`
      : undefined;
    replyTracker.recordIncomingMessage(from, receivedMessage, receiverReceivedAt);
    emitMessageReceipt(receivedMessage.id, "acknowledged", "accepted by receiver");
    const entry = { from, message: receivedMessage, replyCommand, bodyText };
    void (async () => {
      const activeContext = getLiveContext(liveContext, messageGeneration);
      if (!activeContext) {
        return;
      }
      if (!activeContext.isIdle()) {
        if (!activeContext.hasUI) {
          const activeClient = client;
          if (!message.replyTo && activeClient?.isConnected()) {
            try {
              const result = await activeClient.send(from.id, {
                text: "This agent is running in non-interactive mode and cannot respond to intercom messages while it is working. It will continue its current task and exit when done.",
                replyTo: message.id,
              });
              if (result.delivered && getLiveContext(liveContext, messageGeneration)) {
                dismissIncomingAsk(message.id);
              }
            } catch {
              // Best-effort reply; keep the busy non-interactive session running either way.
            }
          }
          return;
        }
        sendIncomingBrokerMessage(entry, "steer");
        return;
      }
      if (getLiveContext(liveContext, messageGeneration)) {
        sendIncomingBrokerMessage(entry, "trigger", messageGeneration);
      }
    })();
  }
  function attachClientHandlers(nextClient: IntercomClient): void {
    nextClient.onBrokerMessage((message: BrokerMessage) => {
      if (client !== nextClient) return;
      switch (message.type) {
        case "registered": {
          const supported = message.features?.includes(EXTENSION_BUS_FEATURE) ?? false;
          if (supported && localExtensions.size > 0) {
            nextClient.updateExtensionCapabilities(currentExtensionCapabilities());
          }
          for (const namespace of localExtensions.keys()) {
            emitLocalExtensionEvent(namespace, { type: "connection", connected: true, supported });
          }
          break;
        }
        case "extension_owner": {
          const extension = localExtensions.get(message.namespace);
          if (!extension) break;
          extension.owner = message.ownerId && message.ownerEpoch
            ? { sessionId: message.ownerId, epoch: message.ownerEpoch }
            : undefined;
          emitLocalExtensionEvent(message.namespace, { type: "owner", ...(extension.owner ? { owner: extension.owner } : {}) });
          break;
        }
        case "extension_message": {
          const extension = localExtensions.get(message.namespace);
          if (!extension) break;
          emitLocalExtensionEvent(message.namespace, {
            type: "message",
            fromSessionId: message.fromSessionId,
            ...(message.ownerId && message.ownerEpoch
              ? { owner: { sessionId: message.ownerId, epoch: message.ownerEpoch } }
              : {}),
            payload: message.payload,
          });
          break;
        }
        case "extension_state": {
          const extension = localExtensions.get(message.namespace);
          if (!extension) break;
          extension.state = { revision: message.revision, payload: message.payload };
          emitLocalExtensionEvent(message.namespace, { type: "state", state: extension.state });
          break;
        }
        case "extension_state_result":
          emitLocalExtensionEvent(message.namespace, {
            type: "state_result",
            committed: message.committed,
            revision: message.revision,
            ...(message.reason ? { reason: message.reason } : {}),
          });
          break;
        case "message_receipt":
          latestOutboundReceipts.set(message.receipt.messageId, {
            status: message.receipt.status,
            timestamp: message.receipt.timestamp,
            ...(message.receipt.detail ? { detail: message.receipt.detail } : {}),
          });
          break;
        case "message_control":
          handleMessageControl(message.control);
          break;
        case "session_joined":
          rememberSession(message.session);
          for (const namespace of localExtensions.keys()) {
            emitLocalExtensionEvent(namespace, { type: "session_joined", session: message.session });
          }
          break;
        case "session_left":
          knownSessions = knownSessions.filter((session) => session.id !== message.sessionId);
          for (const namespace of localExtensions.keys()) {
            emitLocalExtensionEvent(namespace, { type: "session_left", sessionId: message.sessionId });
          }
          break;
        case "presence_update":
          rememberSession(message.session);
          for (const namespace of localExtensions.keys()) {
            emitLocalExtensionEvent(namespace, { type: "presence_update", session: message.session });
          }
          break;
      }
    });
    nextClient.on("message", (from, message) => {
      const liveContext = getLiveContext();
      if (client !== nextClient || !liveContext) {
        return;
      }
      handleIncomingMessage(liveContext, from, message);
    });
    nextClient.on("disconnected", (error: Error) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiter(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      for (const [namespace, extension] of localExtensions) {
        extension.owner = undefined;
        emitLocalExtensionEvent(namespace, { type: "connection", connected: false, supported: false });
        emitLocalExtensionEvent(namespace, { type: "owner" });
      }
      client = null;
      if (!shuttingDown && !disposed) {
        clearReconnectTimer();
        scheduleReconnect();
      }
    });
    nextClient.on("error", () => {
      // Keep broker/socket noise out of the TUI. Reconnect logic runs from the disconnect path.
    });
  }
  function scheduleReconnect(): void {
    if (disposed || shuttingDown || reconnectTimer || reconnectPromise || !getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (scheduledGeneration !== runtimeGeneration || !getLiveContext()) {
        return;
      }
      reconnectAttempt += 1;
      void ensureConnected("background").catch(() => {
        // ensureConnected("background") already queued the next retry.
      });
    }, getReconnectDelayMs());
  }
  async function ensureConnected(reason: "startup" | "background" | "tool" | "overlay"): Promise<IntercomClient> {
    if (!config.enabled) {
      throw new Error("Intercom disabled");
    }
    if (disposed || shuttingDown) {
      throw new Error("Intercom shutting down");
    }
    if (client && client.isConnected()) {
      return client;
    }
    const contextAtStart = getLiveContext();
    const generationAtStart = runtimeGeneration;
    if (!contextAtStart || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }
    clearReconnectTimer();
    if (reconnectPromise && reconnectPromiseGeneration === generationAtStart) {
      return reconnectPromise;
    }
    const nextReconnectPromise = (async () => {
      const nextClient = new IntercomClient();
      client = nextClient;
      attachClientHandlers(nextClient);
      try {
        await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
        await nextClient.connect(buildRegistration(), currentIntercomSessionId ?? currentSessionId);
        if (!getLiveContext(contextAtStart, generationAtStart)) {
          await nextClient.disconnect();
          throw new Error("Intercom runtime no longer active");
        }
        client = nextClient;
        reconnectAttempt = 0;
        // Learn the live roster right away: resolves this session's auto-name
        // (disambiguating against same-repo peers) and primes the roster block.
        void refreshKnownSessions(nextClient).catch(() => undefined);
        return nextClient;
      } catch (error) {
        if (client === nextClient) {
          client = null;
        }
        if (reason === "background" && getLiveContext(contextAtStart, generationAtStart)) {
          scheduleReconnect();
        }
        throw toError(error);
      } finally {
        if (reconnectPromise === nextReconnectPromise) {
          reconnectPromise = null;
          reconnectPromiseGeneration = null;
        }
      }
    })();
    reconnectPromise = nextReconnectPromise;
    reconnectPromiseGeneration = generationAtStart;
    return nextReconnectPromise;
  }
  /**
   * Resolve a target: exact id → exact name → id prefix (upstream order), then
   * the fork's fuzzy match over live peers' names, repos, roles and activity.
   * Returns null when nothing matches, or when the name belongs to an offline
   * session that still holds a mailbox, so send hands the exact name to the
   * broker (mailbox delivery) instead of a live peer that merely resembles it.
   * Ambiguity throws with the candidate list instead of guessing.
   */
  async function resolveSessionTarget(activeClient: IntercomClient, nameOrId: string): Promise<DeliveryTarget | null> {
    const sessions = await activeClient.listSessions();
    if (client === activeClient) knownSessions = sessions;
    const byId = sessions.find(s => s.id === nameOrId);
    if (byId) {
      return { id: byId.id, label: nameOrId };
    }
    const lowerName = nameOrId.toLowerCase();
    const byName = sessions.filter(s => s.name?.toLowerCase() === lowerName);
    if (byName.length > 1) {
      const prefixes = sessionIdPrefixes(sessions);
      const ids = byName.map((session) => prefixes.get(session.id)!).join(", ");
      throw new Error(`Multiple sessions named "${nameOrId}" are connected. Address one by the id shown in parentheses by "list" (${ids}).`);
    }
    if (byName.length === 1) {
      return { id: byName[0]!.id, label: nameOrId };
    }

    const byIdPrefix = sessions.filter(s => s.id.startsWith(nameOrId));
    if (byIdPrefix.length === 1) {
      return { id: byIdPrefix[0]!.id, label: nameOrId };
    }
    if (byIdPrefix.length > 1) {
      throw new Error(`Multiple sessions match ID prefix "${nameOrId}". Use a longer session ID prefix.`);
    }
    if (activeClient.mailboxNames.some((name) => name.toLowerCase() === lowerName)) {
      return null;
    }

    const peers = sessions.filter((session) => session.id !== activeClient.sessionId);
    const match = matchPeer(nameOrId, peers);
    if (match.kind === "ambiguous") {
      throw new AmbiguousPeerError(nameOrId, match.candidates, sessionIdPrefixes(sessions));
    }
    if (match.kind === "unique") {
      return { id: match.session.id, label: `${match.session.name || match.session.id} (matched "${nameOrId}")` };
    }
    return null;
  }
  async function resolveCwdDeliveryTarget(activeClient: IntercomClient, options: {
    to?: string;
    cwd: string;
  }): Promise<DeliveryTarget> {
    const sessions = await activeClient.listSessions();
    const currentSessionId = activeClient.sessionId;
    if (!currentSessionId) {
      throw new Error("Current session is not registered with intercom.");
    }
    const currentSession = sessions.find((session) => session.id === currentSessionId);
    if (!currentSession) {
      throw new Error("Current session is missing from intercom session list.");
    }

    const targetCwd = options.cwd && options.cwd !== "."
      ? resolvePath(currentSession.cwd, options.cwd)
      : currentSession.cwd;
    const existing = resolveTargetInCwd({
      sessions,
      currentSessionId,
      targetCwd,
      ...(options.to ? { to: options.to } : {}),
    });
    if (existing.kind === "found" && existing.session) {
      return { id: existing.session.id, label: options.to || existing.session.name || existing.session.id };
    }
    throw new Error(existing.reason ?? `No intercom session is connected in ${targetCwd}.`);
  }
  function startSessionRuntime(ctx: ExtensionContext): void {
    const previousClient = client;
    failPendingOutboxRequests(runtimeGeneration, "session_ended", "Session replaced");
    shuttingDown = false;
    disposed = false;
    runtimeStarted = true;
    runtimeGeneration += 1;
    outboxRequestIds.clear();
    reconnectAttempt = 0;
    clearReconnectTimer();
    clearStartupConnectTimer();
    clearNamePollTimer();
    rejectReplyWaiter(new Error("Session replaced"));
    replyTracker.reset();
    if (previousClient) {
      client = null;
      void previousClient.disconnect().catch(() => undefined);
    }
    runtimeContext = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    currentIntercomSessionId = resolveConfiguredIntercomSessionId(currentSessionId, config);
    publishIntercomSessionId(currentIntercomSessionId);
    currentModel = ctx.model?.id ?? "unknown";
    sessionStartedAt = Date.now();
    gitInfo = readGitInfo(ctx.cwd);
    autoNameBase = config.autoName ? derivePeerBaseName(ctx.cwd, gitInfo, process.env.HOME) : null;
    // Start from the bare base; the first roster fetch disambiguates (-2, -3…).
    autoName = autoNameBase;
    latestIntent = undefined;
    knownSessions = [];
    role = restoreRole(ctx);
    agentRunning = false;
    activeTools.clear();
    startNamePoll();
    const startupGeneration = runtimeGeneration;
    startupConnectTimer = setTimeout(() => {
      startupConnectTimer = null;
      if (!getLiveContext(ctx, startupGeneration)) {
        return;
      }
      void ensureConnected("startup").catch(() => {
        if (!getLiveContext(ctx, startupGeneration)) {
          return;
        }
        client = null;
        scheduleReconnect();
      });
    }, 0);
  }
  const unsubscribeExtensionRegister = pi.events.on(INTERCOM_EXTENSION_REGISTER_EVENT, (payload) => {
    if (!payload || typeof payload !== "object") return;
    const registration = payload as Partial<IntercomExtensionRegistration>;
    if (
      typeof registration.namespace !== "string"
      || typeof registration.ownerEligible !== "boolean"
      || typeof registration.onEvent !== "function"
      || typeof registration.onReady !== "function"
    ) {
      return;
    }
    registerLocalExtension(registration as IntercomExtensionRegistration);
  });
  pi.events.emit(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, { version: 1 });
  const unsubscribeOutboxRequest = pi.events.on(INTERCOM_OUTBOX_REQUEST_EVENT, handleOutboxRequest);
  // Subagents (task/eval/tan/revive children) coordinate with their parent via
  // OMP's own IRC/Agent Hub. They never register, never get the roster, and
  // never claim an auto-name.
  let subagent = false;
  pi.on("session_start", (_event, ctx) => {
    if (!config.enabled) {
      return;
    }
    subagent = isSubagentSession(ctx.sessionManager);
    if (subagent) {
      return;
    }
    startSessionRuntime(ctx);
  });

  /** Latest persisted /intercom-role for this branch; an empty role clears it. Falls back to $OMP_INTERCOM_ROLE. */
  function restoreRole(ctx: ExtensionContext): string | undefined {
    try {
      const entry = (ctx.sessionManager.getBranch?.() ?? [])
        .findLast((e) => e.type === "custom" && "customType" in e && e.customType === ROLE_ENTRY_TYPE);
      if (!entry) return process.env[ROLE_ENV]?.trim() || undefined;
      const data: unknown = "data" in entry ? entry.data : undefined;
      const value = data && typeof data === "object" && "role" in data ? data.role : undefined;
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    } catch {
      // A session manager without branch access simply has no persisted role.
      return process.env[ROLE_ENV]?.trim() || undefined;
    }
  }

  /** Current roster block, or undefined when intercom is unavailable. Bounded so a stuck broker never stalls a prompt. */
  async function buildRosterBlock(): Promise<string | undefined> {
    let activeClient = client?.isConnected() ? client : null;
    if (!activeClient) {
      let timer: NodeJS.Timeout | undefined;
      activeClient = await Promise.race([
        ensureConnected("background").catch(() => null),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ROSTER_CONNECT_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
    }
    if (!activeClient?.sessionId) {
      return undefined;
    }
    let sessions = knownSessions;
    try {
      sessions = await refreshKnownSessions(activeClient, ROSTER_LIST_TIMEOUT_MS);
    } catch {
      // Fall back to the roster maintained from join/leave/presence events.
    }
    return formatPeerRoster({ selfName: currentIdentity().name, selfId: activeClient.sessionId, sessions });
  }

  pi.on("before_agent_start", async (event, ctx) => {
    if (subagent || !config.enabled || !getLiveContext(ctx)) {
      return;
    }
    const intent = summarizeIntent(event.prompt ?? "");
    if (intent && intent !== latestIntent) {
      latestIntent = intent;
      syncPresenceIdentity();
    }
    if (!config.peerRoster) {
      return;
    }
    const roster = await buildRosterBlock();
    if (!roster || !getLiveContext(ctx)) {
      return;
    }
    // A replacement for this preparation only: rebuilt from the base prompt
    // every time, so the roster is refreshed rather than accumulated.
    return { systemPrompt: [...event.systemPrompt, roster] };
  });
  
  pi.on("session_shutdown", async () => {
    unsubscribeExtensionRegister();
    unsubscribeOutboxRequest();
    shuttingDown = true;
    disposed = true;
    failPendingOutboxRequests(runtimeGeneration, "session_ended", "Session shutting down");
    runtimeGeneration += 1;
    clearStartupConnectTimer();
    clearReconnectTimer();
    clearNamePollTimer();
    restoreIntercomSessionId();
    rejectReplyWaiter(new Error("Session shutting down"));
    replyTracker.reset();
    agentRunning = false;
    activeTools.clear();
    if (client) {
      await client.disconnect();
      client = null;
    }
    runtimeContext = null;
    currentSessionId = null;
    currentIntercomSessionId = null;
    sessionStartedAt = null;
  });
  pi.on("turn_end", () => {
    if (!getLiveContext()) {
      return;
    }
    replyTracker.endTurn();
  });
  pi.on("agent_start", () => {
    if (!getLiveContext()) {
      return;
    }
    agentRunning = true;
    activeTools.clear();
    syncPresenceStatus();
  });
  pi.on("tool_execution_start", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.set(event.toolCallId, event.toolName);
    syncPresenceStatus();
  });
  pi.on("tool_execution_end", (event) => {
    if (!getLiveContext()) {
      return;
    }
    activeTools.delete(event.toolCallId);
    syncPresenceStatus();
  });
  pi.on("agent_end", () => {
    if (!getLiveContext()) {
      return;
    }
    agentRunning = false;
    activeTools.clear();
    syncPresenceStatus();
  });
  pi.on("turn_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!currentSessionId || sessionId !== currentSessionId) {
      if (!config.enabled) {
        return;
      }
      subagent = isSubagentSession(ctx.sessionManager);
      if (subagent) {
        return;
      }
      startSessionRuntime(ctx);
      replyTracker.beginTurn();
      return;
    }
    if (!getLiveContext(ctx)) {
      return;
    }
    currentModel = ctx.model?.id ?? currentModel;
    syncPresenceIdentity();
    replyTracker.beginTurn();
  });

  pi.registerMessageRenderer("intercom_message", (message, options, theme) => {
    const details = message.details as { from: SessionInfo; message: Message; replyCommand?: string; bodyText?: string } | undefined;
    if (!details) return undefined;
    return new InlineMessageComponent(details.from, details.message, theme, details.replyCommand, details.bodyText, !options.expanded);
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "intercom") {
      return;
    }
    if (!event.details || typeof event.details !== "object") {
      return;
    }

    const details = event.details as { error?: unknown; delivered?: unknown };
    if (details.error === true || details.delivered === false) {
      return { isError: true };
    }
  });

  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description: `Send a message to another omp session (peer agent) running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.

Every top-level omp session auto-joins with a readable name (its repo/worktree, e.g.
"model-factory", "model-factory-2"). The <omp-intercom-peers> block in your system prompt
lists who is online, their repo and what they are working on.

When the user refers to another agent ("the MF agent", "leadership", "the ledger session"),
do NOT ask them for a session id: pass their words as \`to\`. \`to\` resolves an exact name,
full session ID, or short id prefix first, then fuzzy-matches peers' names, repos, roles
and current work. If several peers match equally, the call fails and lists the candidates;
pick one or ask the user which. Skip if it resolves to self.

send = notify and continue (queues for a recently disconnected named peer).
ask = block until the peer replies (live peers only; one at a time).

Usage:
  intercom({ action: "list" })                    → List active sessions
  intercom({ action: "list-cwd" })                → List sessions in the current working directory
  intercom({ action: "list-cwd", cwd: "/path" })  → List sessions in a specific directory
  intercom({ action: "send", to: "name-or-id", message: "..." })  → Send message
  intercom({ action: "ask", to: "name-or-id", message: "..." })   → Ask and wait for reply
  intercom({ action: "cancel", messageId: "..." })                 → Request cancellation of a sent message
  intercom({ action: "reply", message: "..." })                      → Reply to the active/single pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status`,
    promptSnippet:
      "Message other local omp agents directly: when the user mentions another agent by name, repo or role, pass that as `to` (no session ids needed). list/send/ask/reply.",

    parameters: Type.Object({
      action: stringEnum(["list", "list-cwd", "send", "ask", "reply", "pending", "status", "cancel"] as const, {
        description: "Action: 'list', 'list-cwd', 'send', 'ask', 'reply', 'pending', 'status', or 'cancel'",
      }),
      to: Type.Optional(Type.String({
        description: "Target session: name, full session ID, short id prefix from 'list', or a description of the peer (repo, role, or what it works on, e.g. 'model factory', 'MF agent', 'leadership'). Ambiguous descriptions return the candidates. For send/ask with cwd, omit to target the sole live session in that cwd. For 'reply', disambiguates the pending ask.",
      })),
      message: Type.Optional(Type.String({
        description: "Message to send (for 'send', 'ask', or 'reply' action)",
      })),
      attachments: Type.Optional(Type.Array(Type.Object({
        type: stringEnum(["file", "snippet", "context"] as const),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      }))),
      replyTo: Type.Optional(Type.String({
        description: "Message ID to reply to (for threading or responding to an 'ask')",
      })),
      messageId: Type.Optional(Type.String({
        description: "Message ID for actions that operate on an existing message, such as 'cancel'.",
      })),
      supersedes: Type.Optional(Type.String({
        description: "Previous message ID this send/ask explicitly supersedes. Only works for the same sender and receiver.",
      })),
      retryOf: Type.Optional(Type.String({
        description: "Previous message ID this send/ask is a user-authored retry of. Retries always send a new message ID.",
      })),
      cwd: Type.Optional(Type.String({
        description: "Working directory filter for 'list-cwd'. For send/ask, scopes target lookup to that directory; omit 'to' to target the sole live peer there. Absolute, or relative to the current session's cwd; '.' means the current cwd.",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (subagent) {
        return {
          content: [{ type: "text", text: "Intercom is disabled in subagent sessions; coordinate with your parent through OMP's native IRC / Agent Hub." }],
          details: { error: true },
        };
      }
      let connectedClient: IntercomClient;
      try {
        connectedClient = await ensureConnected("tool");
      } catch (error) {
        return {
          content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
          details: { error: true },
        };
      }

      syncPresenceIdentity();

      const { action, to, message, attachments, replyTo, messageId, supersedes, retryOf, cwd } = params;

      switch (action) {
        case "list": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const currentSession = sessions.find(s => s.id === mySessionId);
            const otherSessions = sessions.filter(s => s.id !== mySessionId);

            if (!currentSession) {
              return {
                content: [{ type: "text", text: "Current session is missing from intercom session list." }],
                details: { error: true },
              };
            }

            const prefixes = sessionIdPrefixes(sessions);
            const currentSection = `**Current session:**\n${formatSessionListRow(currentSession, currentSession.cwd, true, prefixes.get(currentSession.id)!)}`;
            const otherSection = otherSessions.length === 0
              ? "**Other sessions:**\nNo other sessions connected."
              : `**Other sessions:**\n${otherSessions.map((session) => formatSessionListRow(session, currentSession.cwd, false, prefixes.get(session.id)!)).join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              details: {},
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
        }

        case "list-cwd": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const currentSession = sessions.find(s => s.id === mySessionId);

            if (!currentSession) {
              return {
                content: [{ type: "text", text: "Current session is missing from intercom session list." }],
                details: { error: true },
              };
            }

            // Default to the current session's cwd; an explicit `cwd` overrides
            // (relative paths resolved against it, "." meaning the current cwd).
            const filterCwd = cwd && cwd !== "."
              ? resolvePath(currentSession.cwd, cwd)
              : currentSession.cwd;

            const otherSessions = sessions.filter(
              s => s.id !== mySessionId && sameCwd(s.cwd, filterCwd),
            );

            // Fail loud: filtering by a directory with no peers while the
            // session's OWN cwd has some otherwise reads as a misleading empty
            // result (common when a caller passes a guessed parent cwd).
            let emptyNote = "No other sessions in this directory.";
            if (otherSessions.length === 0 && !sameCwd(filterCwd, currentSession.cwd)) {
              const here = sessions.filter(
                s => s.id !== mySessionId && sameCwd(s.cwd, currentSession.cwd),
              ).length;
              if (here > 0) {
                emptyNote += ` Your session's cwd is ${currentSession.cwd} (${here} peer${here === 1 ? "" : "s"} there) — call list-cwd without a cwd argument to list them.`;
              }
            }

            const prefixes = sessionIdPrefixes(sessions);
            const currentSection = `**Current session:**\n${formatSessionListRow(currentSession, currentSession.cwd, true, prefixes.get(currentSession.id)!)}`;
            const otherSection = otherSessions.length === 0
              ? `**Other sessions (cwd: ${filterCwd}):**\n${emptyNote}`
              : `**Other sessions (cwd: ${filterCwd}):**\n${otherSessions.map((session) => formatSessionListRow(session, currentSession.cwd, false, prefixes.get(session.id)!)).join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              details: {},
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
        }

        case "cancel": {
          if (!messageId) {
            return {
              content: [{ type: "text", text: "Missing 'messageId' parameter" }],
              details: { error: true },
            };
          }
          try {
            const result = await connectedClient.cancelMessage(messageId);
            if (!result.delivered) {
              const errorText = result.reason ?? "Message may not exist or may belong to another sender.";
              return {
                content: [{ type: "text", text: `Cancellation for ${messageId} was not delivered: ${errorText}` }],
                details: { messageId, delivered: false, reason: result.reason },
              };
            }
            return {
              content: [{ type: "text", text: `Cancellation requested for ${messageId}` }],
              details: { messageId, delivered: true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to cancel message: ${getErrorMessage(error)}` }],
              details: { error: true, messageId },
            };
          }
        }

        case "send": {
          if ((!to && !cwd) || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'cwd', or missing 'message' parameter" }],
              details: { error: true },
            };
          }
          try {
            const confirmSend = !replyTo && config.confirmSend && ctx.hasUI;
            const attachmentText = attachments?.length ? formatAttachments(attachments) : "";
            let target: DeliveryTarget;
            if (cwd) {
              target = await resolveCwdDeliveryTarget(connectedClient, { to, cwd });
            } else {
              target = await resolveSessionTarget(connectedClient, to) ?? { id: to, label: to };
            }
            const sendTo = target.id;
            const targetDisplay = cwd ? to ?? target.label : target.label;
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                details: { error: true },
              };
            }
            const activeReplyMismatch = replyTo ? null : replyTracker.findActiveReplyTargetMismatch(sendTo);
            if (activeReplyMismatch) {
              const senderLabel = activeReplyMismatch.from.name || activeReplyMismatch.from.id;
              return {
                content: [{ type: "text", text: `This turn is responding to an intercom ask from "${senderLabel}". Use intercom({ action: "reply", message: "..." }) or set replyTo: "${activeReplyMismatch.message.id}". Refusing non-reply send to "${targetDisplay}" to avoid a misdirected reply.` }],
                details: { error: true, replyTo: activeReplyMismatch.message.id },
              };
            }
            const inferredAsk = replyTo ? null : replyTracker.findUniquePendingAskFrom(sendTo);
            const effectiveReplyTo = replyTo ?? inferredAsk?.message.id;
            if (confirmSend) {
              const confirmed = await ctx.ui.confirm(
                "Send message",
                `Send to "${targetDisplay}":\n\n${message}${attachmentText}`,
              );
              if (!confirmed) {
                return {
                  content: [{ type: "text", text: "Message cancelled by user" }],
                  details: {},
                };
              }
            }
            const result = await connectedClient.send(sendTo, {
              text: message,
              attachments,
              replyTo: effectiveReplyTo,
              supersedes,
              retryOf,
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Message to "${targetDisplay}" was not delivered: ${errorText}` }],
                details: deliveryDetails(result),
              };
            }
            pi.appendEntry("intercom_sent", {
              to: targetDisplay,
              message: { text: message, attachments, replyTo: effectiveReplyTo, supersedes, retryOf },
              messageId: result.id,
              timestamp: Date.now(),
            });
            if (effectiveReplyTo) {
              dismissIncomingAsk(effectiveReplyTo);
            }
            return {
              content: [{
                type: "text",
                text: inferredAsk ? `Reply sent to ${targetDisplay} (inferred from pending ask)` : `Message sent to ${targetDisplay}`,
              }],
              details: {
                ...deliveryDetails(result),
                ...(effectiveReplyTo ? { replyTo: effectiveReplyTo } : {}),
              },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send: ${getErrorMessage(error)}` }],
              details: { error: true, ...(error instanceof AmbiguousPeerError ? { ambiguous: true, candidates: error.candidates.map(({ session }) => session.name || session.id) } : {}) },
            };
          }
        }

        case "ask": {
          if ((!to && !cwd) || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'cwd', or missing 'message' parameter" }],
              details: { error: true },
            };
          }

          if (replyWaiter) {
            return {
              content: [{ type: "text", text: "Already waiting for a reply" }],
              details: { error: true },
            };
          }

          if (_signal?.aborted) {
            return {
              content: [{ type: "text", text: "Cancelled" }],
              details: { error: true },
            };
          }
          let replyPromise: Promise<Message> | null = null;
          let deliveryState = "created";
          let questionId: string | null = null;

          try {
            let target: DeliveryTarget;
            if (cwd) {
              target = await resolveCwdDeliveryTarget(connectedClient, { to, cwd });
            } else {
              const resolved = await resolveSessionTarget(connectedClient, to);
              if (!resolved) {
                return {
                  content: [{ type: "text", text: `Session "${to}" is not currently connected. Blocking asks are not queued; use send for a non-blocking mailbox delivery or retry after the session reconnects.` }],
                  details: { error: true },
                };
              }
              target = resolved;
            }
            const sendTo = target.id;
            const targetDisplay = cwd ? to ?? target.label : target.label;
            if (_signal?.aborted) {
              return {
                content: [{ type: "text", text: "Cancelled" }],
                details: { error: true },
              };
            }
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                details: { error: true },
              };
            }
            if (replyWaiter) {
              return {
                content: [{ type: "text", text: "Already waiting for a reply" }],
                details: { error: true },
              };
            }
            questionId = randomUUID();
            replyPromise = waitForReply(sendTo, questionId, _signal, () => connectedClient.cancelAsk(questionId!), () => latestDeliveryState(questionId, deliveryState));
            replyPromise.catch(() => undefined);
            const sendResult = await connectedClient.send(sendTo, {
              messageId: questionId,
              text: message,
              attachments,
              replyTo,
              expectsReply: true,
              supersedes,
              retryOf,
            });

            deliveryState = sendResult.delivery;
            if (!sendResult.delivered) {
              const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
              rejectReplyWaiter(new Error(`Message to "${targetDisplay}" was not delivered: ${errorText}`));
              if (replyPromise) {
                try {
                  await replyPromise;
                } catch {
                  // The waiter was already rejected above. Keep the delivery failure as the only error here.
                }
              }
              return {
                content: [{ type: "text", text: `Message to "${targetDisplay}" was not delivered: ${errorText}` }],
                details: { error: true, ...deliveryDetails(sendResult) },
              };
            }
            pi.appendEntry("intercom_sent", {
              to: targetDisplay,
              message: { text: message, attachments, replyTo, supersedes, retryOf },
              messageId: sendResult.id,
              timestamp: Date.now(),
            });
            const replyMessage = await replyPromise;
            const replyText = replyMessage.content.text;
            const replyAttachments = replyMessage.content.attachments?.length
              ? formatAttachments(replyMessage.content.attachments)
              : "";
            pi.appendEntry("intercom_received", {
              from: targetDisplay,
              message: { text: replyText, attachments: replyMessage.content.attachments },
              messageId: replyMessage.id,
              timestamp: replyMessage.timestamp,
            });
            return {
              content: [{ type: "text", text: `**Reply from ${targetDisplay}:**\n${replyText}${replyAttachments}` }],
              details: {},
            };
          } catch (error) {
            rejectReplyWaiter(toError(error));
            if (replyPromise) {
              try {
                await replyPromise;
              } catch {
                // The waiter is cleanup-only on this path. The real failure is the one from the outer catch.
              }
            }
            return {
              content: [{ type: "text", text: `Failed: ${getErrorMessage(error)}` }],
              details: { error: true, ...(questionId ? { messageId: questionId, deliveryState: latestDeliveryState(questionId, deliveryState) } : {}) },
            };
          }
        }

        case "reply": {
          if (!message) {
            return {
              content: [{ type: "text", text: "Missing 'message' parameter" }],
              details: { error: true },
            };
          }

          try {
            const target = replyTracker.resolveReplyTarget({ to, replyTo });
            if (target.from.id === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                details: { error: true },
              };
            }
            const result = await connectedClient.send(target.from.id, {
              text: message,
              attachments,
              replyTo: target.message.id,
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              if (result.reason === "Session not found") {
                dismissIncomingAsk(target.message.id);
              }
              return {
                content: [{ type: "text", text: `Reply to "${target.from.name || target.from.id}" was not delivered: ${errorText}` }],
                details: deliveryDetails(result),
              };
            }
            dismissIncomingAsk(target.message.id);
            pi.appendEntry("intercom_sent", {
              to: target.from.name || target.from.id,
              message: { text: message, attachments, replyTo: target.message.id },
              messageId: result.id,
              timestamp: Date.now(),
            });
            return {
              content: [{ type: "text", text: `Reply sent to ${target.from.name || target.from.id}` }],
              details: { ...deliveryDetails(result), replyTo: target.message.id },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to reply: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
        }

        case "pending": {
          const pendingAsks = replyTracker.listPending();
          if (pendingAsks.length === 0) {
            return {
              content: [{ type: "text", text: "No unresolved inbound asks." }],
              details: {},
            };
          }

          const now = Date.now();
          const lines = pendingAsks.map(({ from, message, receivedAt }) => {
            const preview = message.content.text.replace(/\s+/g, " ").slice(0, 80);
            const elapsedSeconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
            return `- ${from.name || from.id} · ${message.id} · ${elapsedSeconds}s ago · ${preview}`;
          });
          return {
            content: [{ type: "text", text: `**Pending asks:**\n${lines.join("\n")}` }],
            details: {},
          };
        }

        case "status": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            return {
              content: [{
                type: "text",
                text: `**Intercom Status:**\nConnected: Yes\nSession ID: ${mySessionId}\nActive sessions: ${sessions.length}`,
              }],
              details: {},
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to get status: ${getErrorMessage(error)}` }],
              details: { error: true },
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}` }],
            details: { error: true },
          };
      }
    },
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "intercom";
      const target = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
      const messagePreview = previewText(args.message, 96);
      const attachmentCount = Array.isArray(args.attachments) ? args.attachments.length : 0;
      let text = theme.fg("toolTitle", theme.bold("intercom "));
      text += theme.fg(action === "ask" ? "warning" : action === "reply" ? "success" : "accent", action);
      if (target) {
        text += " " + theme.fg("muted", "→") + " " + theme.fg("accent", target);
      }
      if (attachmentCount > 0) {
        text += " " + theme.fg("dim", `(${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"})`);
      }
      if (messagePreview) {
        text += "\n  " + theme.fg("dim", messagePreview);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Intercom working..."), 0, 0);
      }
      const details = result.details as { delivered?: boolean; error?: boolean; messageId?: string; reason?: string } | undefined;
      const failed = Boolean(context.isError || details?.error === true || details?.delivered === false);
      let text = failed ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
      text += theme.fg(failed ? "error" : "text", firstTextContent(result));
      if (details?.messageId && !context.expanded) {
        text += theme.fg("dim", ` (${details.messageId.slice(0, 8)})`);
      }
      if (details?.reason && context.expanded) {
        text += "\n" + theme.fg("dim", `Reason: ${details.reason}`);
      }
      return new Text(text, 0, 0);
    },
  });

  function insertIntoEditor(ctx: ExtensionContext, text: string): boolean {
    if (!ctx.hasUI) return false;
    const ui = ctx.ui as { getEditorText?: () => string; setEditorText?: (text: string) => void };
    if (typeof ui.setEditorText !== "function") return false;
    const existing = typeof ui.getEditorText === "function" ? ui.getEditorText() : "";
    ui.setEditorText(existing.trim() ? `${existing.trimEnd()}\n\n${text}` : text);
    return true;
  }

  async function insertIntercomId(ctx: ExtensionContext): Promise<void> {
    const commandGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, commandGeneration);
    if (!liveContext) return;
    let contactClient: IntercomClient;
    try {
      contactClient = await ensureConnected("tool");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", commandGeneration);
      return;
    }
    const sessionId = contactClient.sessionId;
    if (!sessionId || !getLiveContext(liveContext, commandGeneration)) return;
    const snippet = formatIntercomContactSnippet(sessionId);
    if (insertIntoEditor(liveContext, snippet)) {
      notifyIfLive(liveContext, `Inserted intercom contact target: ${sessionId}`, "info", commandGeneration);
      return;
    }
    notifyIfLive(liveContext, `Intercom contact target: ${sessionId}`, "info", commandGeneration);
  }

  async function setIntercomAlias(args: string, ctx: ExtensionContext): Promise<void> {
    const commandGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, commandGeneration);
    if (!liveContext) return;

    let alias = args.trim();
    const opensAliasInput = !alias || alias.toLowerCase() === "menu";
    if (opensAliasInput) {
      if (!liveContext.hasUI) {
        const currentAlias = pi.getSessionName()?.trim();
        notifyAliasCommand(
          liveContext,
          alias ? "The alias menu requires an interactive UI; use /alias <name>." : currentAlias ? `Session alias: ${currentAlias}` : "No session alias set. Use /alias <name>.",
          alias ? "warning" : "info",
          commandGeneration,
        );
        return;
      }

      const currentAlias = pi.getSessionName()?.trim();
      let entered: string | undefined;
      try {
        entered = await liveContext.ui.input(
          "Set session alias",
          currentAlias ? `Current alias: ${currentAlias}` : "Enter an alias",
        );
      } catch (error) {
        notifyAliasCommand(liveContext, `Unable to set session alias: ${getErrorMessage(error)}`, "error", commandGeneration);
        return;
      }
      if (entered === undefined) return;
      alias = entered.trim();
      if (!alias) {
        notifyAliasCommand(liveContext, "Session alias cannot be empty.", "warning", commandGeneration);
        return;
      }
    }

    if (!getLiveContext(liveContext, commandGeneration)) return;
    try {
      pi.setSessionName(alias);
    } catch (error) {
      notifyAliasCommand(liveContext, `Unable to set session alias: ${getErrorMessage(error)}`, "error", commandGeneration);
      return;
    }

    // Pi's session_info_changed event updates the built-in UI, but it is not
    // an ExtensionAPI event. Push the new identity directly so broker peers
    // see the alias without waiting for the idle name poll.
    syncPresenceIdentity();
    notifyAliasCommand(liveContext, `Session alias set: ${alias}`, "info", commandGeneration);
  }

  async function openIntercomOverlay(ctx: ExtensionContext): Promise<void> {
    const overlayGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, overlayGeneration);
    if (!liveContext?.hasUI || (liveContext as ExtensionContext & { mode?: string }).mode !== "tui") return;

    let overlayClient: IntercomClient;
    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    syncPresenceIdentity();

    let currentSession: SessionInfo;
    let sessions: SessionInfo[];
    let duplicates: Set<string>;
    try {
      const mySessionId = overlayClient.sessionId;
      const allSessions = await overlayClient.listSessions();
      if (!getLiveContext(ctx, overlayGeneration)) return;
      const foundCurrentSession = allSessions.find(s => s.id === mySessionId);
      if (!foundCurrentSession) {
        notifyIfLive(ctx, "Current session is missing from intercom session list", "error", overlayGeneration);
        return;
      }
      currentSession = foundCurrentSession;
      duplicates = duplicateSessionNames(allSessions);
      sessions = allSessions.filter(s => s.id !== mySessionId);
    } catch (error) {
      notifyIfLive(ctx, `Failed to list sessions: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }

    const selectedSession = await ctx.ui.custom<SessionInfo | undefined>(
      (_tui, theme, keybindings, done) => new SessionListOverlay(theme, keybindings, currentSession, sessions, done),
      { overlay: true, overlayOptions: { width: 88 } }
    ).catch(() => undefined);

    if (!selectedSession || !getLiveContext(ctx, overlayGeneration)) return;

    try {
      overlayClient = await ensureConnected("overlay");
    } catch (error) {
      notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!getLiveContext(ctx, overlayGeneration)) return;

    const targetLabel = formatSessionLabel(selectedSession, duplicates);

    const result = await ctx.ui.custom<ComposeResult>(
      (tui, theme, keybindings, done) => new ComposeOverlay(tui, theme, keybindings, selectedSession, targetLabel, overlayClient, done),
      { overlay: true, overlayOptions: { width: 72 } }
    ).catch(() => undefined);

    if (result?.sent && result.messageId && result.text && getLiveContext(ctx, overlayGeneration)) {
      pi.appendEntry("intercom_sent", {
        to: selectedSession.name || selectedSession.id,
        message: { text: result.text },
        messageId: result.messageId,
        timestamp: Date.now(),
      });
      notifyIfLive(ctx, `Message sent to ${targetLabel}`, "info", overlayGeneration);
    }
  }

  pi.registerCommand("intercom", {
    description: "Open session intercom overlay",
    handler: async (_args, ctx) => openIntercomOverlay(ctx),
  });

  pi.registerCommand("intercom-id", {
    description: "Insert a stable omp-intercom handoff snippet for this session into the editor",
    handler: async (_args, ctx) => insertIntercomId(ctx),
  });

  pi.registerCommand("alias", {
    description: "Set the current session alias (usage: /alias <name> or /alias menu)",
    handler: async (args, ctx) => setIntercomAlias(args, ctx),
  });

  pi.registerCommand("intercom-role", {
    description: "Describe this session's role to peer agents (usage: /intercom-role <role>, e.g. 'leadership', or /intercom-role clear)",
    handler: async (args, ctx) => {
      const commandGeneration = runtimeGeneration;
      if (subagent || !getLiveContext(ctx, commandGeneration)) return;
      const next = args.trim();
      if (!next) {
        notifyAliasCommand(ctx, role ? `Intercom role: ${role}` : "No intercom role set. Use /intercom-role <role>.", "info", commandGeneration);
        return;
      }
      role = next.toLowerCase() === "clear" ? undefined : next;
      pi.appendEntry(ROLE_ENTRY_TYPE, { role: role ?? "" });
      syncPresenceIdentity();
      notifyAliasCommand(ctx, role ? `Intercom role set: ${role}` : "Intercom role cleared.", "info", commandGeneration);
    },
  });

  pi.registerShortcut("alt+i", {
    description: "Open session intercom",
    handler: async (ctx) => openIntercomOverlay(ctx),
  });
}
