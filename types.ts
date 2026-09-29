export const EXTENSION_BUS_FEATURE = "extension-bus-v1";
export const EXACT_SEND_FEATURE = "exact-send-v1";

export type DeliveryState = "socket_delivered" | "queued" | "failed" | "unknown";

export interface DeliveryDetails {
  delivery: DeliveryState;
  code?: string;
  retryable: boolean;
  outcomeKnown: boolean;
}

/**
 * Short, secret-free description of a peer published through presence so other
 * sessions can reason about who does what (omp-intercom Straker fork).
 * Every field is optional and length-capped by the broker.
 */
export interface PeerProfile {
  /** Git repository name (main repo root basename; worktrees resolve to their main repo). */
  repo?: string;
  /** Linked git worktree directory name when it differs from the repo name. */
  worktree?: string;
  /** Current git branch. */
  branch?: string;
  /** Explicit role set by the user (/intercom-role or OMP_INTERCOM_ROLE). */
  role?: string;
  /** Auto-generated session title (current activity). */
  title?: string;
  /** Clipped, redacted first line of the most recent user prompt. */
  intent?: string;
  /** Host terminal handle (e.g. Orca terminal handle or tmux pane). */
  terminal?: string;
}

export interface SessionInfo {
  id: string;
  /** Broker-owned lifetime of this live endpoint. */
  endpointEpoch?: string;
  name?: string;
  /** True only when the extension synthesized name for an unnamed runtime. */
  runtimeFallbackAlias?: boolean;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  peerUid?: number;
  trustedLocal?: boolean;
  /** Live context-window usage, pushed via presence from the source session's
   *  getContextUsage(). contextPct is 0..100 (rounded); contextTokens /
   *  contextWindow are raw token counts. All optional: unknown right after a
   *  compaction (before the next assistant response), when no model is selected,
   *  or on older clients that never report it. */
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
  /** tmux pane id (e.g. "%212") of the session's terminal, read from
   *  $TMUX_PANE at registration. Present only when the session runs inside a
   *  tmux pane; absent for cloud, headless, or IDE-embedded sessions.
   *  The pane id is immutable for the process lifetime — unlike the window
   *  name, which is mutable — so a peer can live-resolve the current window
   *  from it via tmux when it needs to introspect or drive that pane. */
  tmuxPane?: string;
  /** Peer profile published by omp-intercom (Straker fork). Absent on older clients. */
  profile?: PeerProfile;
}

export interface Message {
  id: string;
  timestamp: number;
  senderSequence?: number;
  brokerReceivedAt?: number;
  brokerDeliveredAt?: number;
  receiverReceivedAt?: number;
  injectedAt?: number;
  supersedes?: string;
  retryOf?: string;
  replyTo?: string;
  expectsReply?: boolean;
  provenance?: MessageProvenance;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface MessageProvenance {
  type: "extension_outbox";
  extensionId: string;
  extensionName: string;
  requestId: string;
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export type MessageReceiptStatus = "receiver_received" | "queued" | "injected" | "acknowledged" | "expired" | "cancelled" | "superseded" | "cancellation_requested";

export interface MessageReceipt {
  messageId: string;
  status: MessageReceiptStatus;
  timestamp: number;
  detail?: string;
}

export type MessageControlAction = "cancel" | "supersede";

export interface MessageControl {
  messageId: string;
  action: MessageControlAction;
  timestamp: number;
  supersededBy?: string;
  detail?: string;
}

export interface ExtensionCapability {
  namespace: string;
  ownerEligible: boolean;
}

export type SessionRegistration = Omit<SessionInfo, "id" | "endpointEpoch" | "peerUid" | "trustedLocal"> & {
  extensions?: ExtensionCapability[];
};

export type ClientMessage =
  | { type: "register"; session: SessionRegistration; sessionId?: string; stateId?: string; scopeId?: string }
  | { type: "unregister" }
  | { type: "extension_capabilities_update"; extensions: ExtensionCapability[] }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message; targetId?: string; targetEpoch?: string }
  | { type: "message_receipt"; receipt: MessageReceipt }
  | { type: "cancel_message"; messageId: string }
  | { type: "cancel_ask"; messageId: string }
  | { type: "presence"; name?: string; runtimeFallbackAlias?: boolean; status?: string; model?: string; contextPct?: number | null; contextTokens?: number | null; contextWindow?: number | null; profile?: PeerProfile }
  | {
      type: "extension_publish";
      namespace: string;
      audience: "owner" | "capable";
      ownerEpoch?: string;
      ownerOnly?: boolean;
      payload: unknown;
    }
  | {
      type: "extension_state_commit";
      namespace: string;
      ownerEpoch: string;
      expectedRevision: number;
      payload: unknown;
    };

export type BrokerMessage =
  | { type: "registered"; sessionId: string; features?: string[] }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | ({ type: "delivered"; messageId: string } & DeliveryDetails)
  | ({ type: "delivery_failed"; messageId: string; reason: string } & DeliveryDetails)
  | { type: "message_receipt"; from: SessionInfo; receipt: MessageReceipt }
  | { type: "message_control"; from: SessionInfo; control: MessageControl }
  | { type: "extension_owner"; namespace: string; ownerId?: string; ownerEpoch?: string }
  | {
      type: "extension_message";
      namespace: string;
      fromSessionId: string;
      ownerId?: string;
      ownerEpoch?: string;
      payload: unknown;
    }
  | {
      type: "extension_state";
      namespace: string;
      revision: number;
      payload: unknown;
    }
  | {
      type: "extension_state_result";
      namespace: string;
      committed: boolean;
      revision: number;
      reason?: string;
    };
