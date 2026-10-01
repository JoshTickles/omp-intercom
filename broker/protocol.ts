import type {
  Attachment,
  Message,
  MessageControl,
  MessageProvenance,
  MessageReceipt,
  MessageReceiptStatus,
  PeerProfile,
  SessionInfo,
  SessionRegistration,
} from "../types.ts";

export const PEER_PROFILE_FIELDS = ["repo", "worktree", "branch", "role", "title", "intent"] as const;
export const PEER_PROFILE_FIELD_MAX_LENGTH = 160;

/** Cut to `max` characters, ending in an ellipsis when anything was dropped. */
export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Accepts an object whose known fields are optional strings. Unknown fields are
 * tolerated (forward compatibility) and dropped by normalizePeerProfile.
 */
export function isPeerProfile(value: unknown): value is PeerProfile {
  if (!isRecord(value)) {
    return false;
  }
  return PEER_PROFILE_FIELDS.every((key) => value[key] === undefined || typeof value[key] === "string");
}

/** Keep only known, non-empty fields, collapse whitespace, and cap each field's length. */
export function normalizePeerProfile(profile: PeerProfile): PeerProfile {
  const normalized: PeerProfile = {};
  for (const key of PEER_PROFILE_FIELDS) {
    const raw = profile[key];
    if (typeof raw !== "string") continue;
    const value = raw.replace(/\s+/g, " ").trim();
    if (!value) continue;
    normalized[key] = clip(value, PEER_PROFILE_FIELD_MAX_LENGTH);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageReceiptStatus(value: unknown): value is MessageReceiptStatus {
  return value === "receiver_received"
    || value === "queued"
    || value === "injected"
    || value === "acknowledged"
    || value === "expired"
    || value === "cancelled"
    || value === "superseded"
    || value === "cancellation_requested";
}

export function isMessageReceipt(value: unknown): value is MessageReceipt {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.messageId !== "string" || !isMessageReceiptStatus(value.status) || typeof value.timestamp !== "number") {
    return false;
  }
  return value.detail === undefined || typeof value.detail === "string";
}

export function isMessageControl(value: unknown): value is MessageControl {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.messageId !== "string" || typeof value.timestamp !== "number") {
    return false;
  }
  if (value.action !== "cancel" && value.action !== "supersede") {
    return false;
  }
  if (value.supersededBy !== undefined && typeof value.supersededBy !== "string") {
    return false;
  }
  return value.detail === undefined || typeof value.detail === "string";
}

function isAttachment(value: unknown): value is Attachment {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.type !== "file"
    && value.type !== "snippet"
    && value.type !== "context"
  ) {
    return false;
  }

  if (typeof value.name !== "string" || typeof value.content !== "string") {
    return false;
  }

  return value.language === undefined || typeof value.language === "string";
}

function isMessageProvenance(value: unknown): value is MessageProvenance {
  if (!isRecord(value)) {
    return false;
  }
  return value.type === "extension_outbox"
    && typeof value.extensionId === "string"
    && typeof value.extensionName === "string"
    && typeof value.requestId === "string";
}

export function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.id !== "string" || typeof value.timestamp !== "number") {
    return false;
  }

  for (const key of ["senderSequence", "brokerReceivedAt", "brokerDeliveredAt", "receiverReceivedAt", "injectedAt"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "number") {
      return false;
    }
  }

  if (value.supersedes !== undefined && typeof value.supersedes !== "string") {
    return false;
  }

  if (value.retryOf !== undefined && typeof value.retryOf !== "string") {
    return false;
  }

  if (value.replyTo !== undefined && typeof value.replyTo !== "string") {
    return false;
  }

  if (value.expectsReply !== undefined && typeof value.expectsReply !== "boolean") {
    return false;
  }

  if (value.provenance !== undefined && !isMessageProvenance(value.provenance)) {
    return false;
  }

  if (!isRecord(value.content) || typeof value.content.text !== "string") {
    return false;
  }

  return value.content.attachments === undefined
    || (Array.isArray(value.content.attachments) && value.content.attachments.every(isAttachment));
}

export function isSessionInfo(value: unknown): value is SessionInfo {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.id !== "string"
    || typeof value.cwd !== "string"
    || typeof value.model !== "string"
    || typeof value.pid !== "number"
    || typeof value.startedAt !== "number"
    || typeof value.lastActivity !== "number"
  ) {
    return false;
  }

  if (value.endpointEpoch !== undefined && typeof value.endpointEpoch !== "string") {
    return false;
  }

  if (value.name !== undefined && typeof value.name !== "string") {
    return false;
  }

  if (value.runtimeFallbackAlias !== undefined && typeof value.runtimeFallbackAlias !== "boolean") {
    return false;
  }

  if (value.status !== undefined && typeof value.status !== "string") {
    return false;
  }

  if (value.peerUid !== undefined && typeof value.peerUid !== "number") {
    return false;
  }

  for (const key of ["contextPct", "contextTokens", "contextWindow"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "number") {
      return false;
    }
  }

  if (value.tmuxPane !== undefined && typeof value.tmuxPane !== "string") {
    return false;
  }

  if (value.profile !== undefined && !isPeerProfile(value.profile)) {
    return false;
  }

  return value.trustedLocal === undefined || typeof value.trustedLocal === "boolean";
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isSessionRegistration(value: unknown): value is SessionRegistration {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.cwd !== "string"
    || typeof value.model !== "string"
    || typeof value.pid !== "number"
    || typeof value.startedAt !== "number"
    || typeof value.lastActivity !== "number"
  ) {
    return false;
  }

  if (value.name !== undefined && typeof value.name !== "string") {
    return false;
  }
  if (value.runtimeFallbackAlias !== undefined && typeof value.runtimeFallbackAlias !== "boolean") {
    return false;
  }
  if (value.extensions !== undefined && !Array.isArray(value.extensions)) {
    return false;
  }
  if (value.tmuxPane !== undefined && typeof value.tmuxPane !== "string") {
    return false;
  }
  if (value.profile !== undefined && !isPeerProfile(value.profile)) {
    return false;
  }

  return value.status === undefined || typeof value.status === "string";
}
