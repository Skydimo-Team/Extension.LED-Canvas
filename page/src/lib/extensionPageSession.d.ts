export interface ExtensionSessionError extends Error {
  code: string | number;
  fatal: boolean;
}
export interface ExtensionSessionRequest {
  id?: string | number;
  method: string;
  params?: { data?: { type?: string; callId?: string } };
}
export function resolveExtensionSessionToken(windowObject?: unknown): string;
export function authenticateExtensionSocket(
  socket: WebSocket,
  options?: {
    token?: string;
    authTimeoutMs?: number;
    rpcTimeoutMs?: number;
    onError?: (error: ExtensionSessionError, request?: ExtensionSessionRequest) => void;
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
  },
): void;
