// Cross-world & cross-thread messaging protocol (SPEC §3.3).
// All messages carry version, requestId, type and a validated payload.
// Page-originated content is treated as untrusted input.

export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const BRIDGE_SOURCE = "pg4-bridge" as const;
export const CONTENT_SOURCE = "pg4-content" as const;

/** Maximum single SQL / DDL payload length accepted from the page bridge (resource-exhaustion guard). */
export const MAX_PAGE_PAYLOAD_CHARS = 1_500_000;

/** Detail string is truncated when sent from page to extension to avoid log storms. */
export type BridgeMessage =
  | { version: typeof BRIDGE_PROTOCOL_VERSION; requestId: string; source: typeof BRIDGE_SOURCE; type: "editor-ready"; editorId: string; cmVersion?: string }
  | { version: typeof BRIDGE_PROTOCOL_VERSION; requestId: string; source: typeof BRIDGE_SOURCE; type: "editor-state"; editorId: string; sql: string; cursor: number; selection: { from: number; to: number }; transactionKind: "input" | "paste" | "selection"; scrollRect?: DOMRectLike }
  | { version: typeof BRIDGE_PROTOCOL_VERSION; requestId: string; source: typeof BRIDGE_SOURCE; type: "editor-change"; editorId: string; sql: string; cursor: number; selection: { from: number; to: number }; transactionKind: "input" | "paste" | "selection"; scrollRect?: DOMRectLike }
  | { version: typeof BRIDGE_PROTOCOL_VERSION; requestId: string; source: typeof BRIDGE_SOURCE; type: "editor-blur"; editorId: string }
  | { version: typeof BRIDGE_PROTOCOL_VERSION; requestId: string; source: typeof BRIDGE_SOURCE; type: "bridge-error"; code: string; detail?: string }
  | { version: typeof BRIDGE_PROTOCOL_VERSION; requestId: string; source: typeof BRIDGE_SOURCE; type: "executing-query"; editorId: string; sql: string };

/** Messages from content script -> bridge (extension-controlled, must carry extension nonce). */
export type ExtensionToBridgeMessage =
  | { version: typeof BRIDGE_PROTOCOL_VERSION; requestId: string; source: typeof CONTENT_SOURCE; nonce: string; type: "apply-completion"; editorId: string; from: number; to: number; insert: string }
  | { version: typeof BRIDGE_PROTOCOL_VERSION; requestId: string; source: typeof CONTENT_SOURCE; nonce: string; type: "request-state"; editorId: string }
  | { version: typeof BRIDGE_PROTOCOL_VERSION; requestId: string; source: typeof CONTENT_SOURCE; nonce: string; type: "focus"; editorId: string }
  | { version: typeof BRIDGE_PROTOCOL_VERSION; requestId: string; source: typeof CONTENT_SOURCE; nonce: string; type: "teardown"; editorId: string };

export interface DOMRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function isBridgeMessage(v: unknown): v is BridgeMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    m.version === BRIDGE_PROTOCOL_VERSION &&
    typeof m.requestId === "string" &&
    typeof m.type === "string" &&
    typeof m.source === "string"
  );
}

export function isExtensionToBridgeMessage(v: unknown): v is ExtensionToBridgeMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    m.version === BRIDGE_PROTOCOL_VERSION &&
    typeof m.requestId === "string" &&
    m.source === CONTENT_SOURCE &&
    typeof m.nonce === "string"
  );
}

/** Generate a short request id without external deps. */
export function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Generate a random extension nonce used to authenticate extension -> bridge writes. */
export function newNonce(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}
