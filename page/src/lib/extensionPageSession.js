/**
 * Shared extension-page session contract. Keep vendored copies source-identical;
 * scripts/extension-page-session.test.mjs checks them.
 * WebSocket open is transport readiness, not Core authentication.
 */
export function resolveExtensionSessionToken(windowObject = globalThis.window) {
  const injected = windowObject?.__SKYDIMO_EXT_PAGE__?.wsToken;
  const query = new URLSearchParams(windowObject?.location?.search ?? "");
  return typeof injected === "string" && injected.trim()
    ? injected
    : query.get("wsToken") ?? query.get("token") ?? "";
}

export function authenticateExtensionSocket(socket, options = {}) {
  const token = options.token ?? resolveExtensionSessionToken();
  const setTimer = options.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  const rawSend = socket.send.bind(socket);
  const rawClose = socket.close.bind(socket);
  const onOpen = socket.onopen;
  const onMessage = socket.onmessage;
  const onClose = socket.onclose;
  const authId = "skydimo-page-authenticate";
  const pending = new Map();
  let ready = false;
  let closed = false;
  let closing = false;
  let authTimer = null;
  let openEvent;

  function report(message, code, request, fatal = false) {
    const error = new Error(message);
    error.code = code;
    error.fatal = fatal;
    options.onError?.(error, request);
    return error;
  }

  function clearAuthTimer() {
    if (authTimer !== null) clearTimer(authTimer);
    authTimer = null;
  }

  function failAuthentication(message) {
    if (closed || closing || ready) return;
    clearAuthTimer();
    // The token must never enter a log or UI error.
    report(message, "authentication_failed", undefined, true);
    socket.close(4001, "Core authentication failed");
  }

  socket.onopen = (event) => {
    if (closed || closing) return;
    if (!token) {
      failAuthentication("Core session token is missing. Reopen the extension page.");
      return;
    }
    authTimer = setTimer(
      () => failAuthentication("Core authentication timed out. Reopen the extension page."),
      options.authTimeoutMs ?? 5000,
    );
    openEvent = event;
    rawSend(JSON.stringify({
      jsonrpc: "2.0",
      id: authId,
      method: "authenticate",
      params: { token },
    }));
  };

  // Close cleanup must also run when a page detaches its onclose handler.
  socket.close = (...args) => {
    closing = true;
    ready = false;
    clearAuthTimer();
    for (const { timer } of pending.values()) clearTimer(timer);
    pending.clear();
    return rawClose(...args);
  };

  socket.send = (data) => {
    if (!ready || closed) {
      throw new Error("Core connection is not authenticated.");
    }
    let request;
    try { request = JSON.parse(data); } catch { /* native send handles non-JSON */ }
    if (request && request.id !== undefined && typeof request.method === "string") {
      const timer = setTimer(() => {
        pending.delete(request.id);
        report("Core request timed out: " + request.method, "rpc_timeout", request);
      }, options.rpcTimeoutMs ?? 30000);
      pending.set(request.id, { request, timer });
    }
    try {
      rawSend(data);
    } catch (error) {
      const entry = request && pending.get(request.id);
      if (entry) clearTimer(entry.timer);
      if (request) pending.delete(request.id);
      throw error;
    }
  };

  socket.onmessage = (event) => {
    if (closed || closing) return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (!payload || typeof payload !== "object") return;
    if (!ready) {
      if (payload.id !== authId) return;
      if (payload.error || payload.result?.authenticated !== true) {
        failAuthentication("Core authentication was rejected. Reopen the extension page.");
        return;
      }
      clearAuthTimer();
      ready = true;
      onOpen?.call(socket, openEvent);
      openEvent = undefined;
      return;
    }
    if (payload.id !== undefined && ("result" in payload || "error" in payload)) {
      const entry = pending.get(payload.id);
      if (entry) {
        clearTimer(entry.timer);
        pending.delete(payload.id);
        if (payload.error) {
          report(
            typeof payload.error.message === "string" ? payload.error.message : "Core rejected the request.",
            payload.error.code ?? "rpc_error",
            entry.request,
          );
        }
      }
    }
    onMessage?.call(socket, event);
  };

  socket.onclose = (event) => {
    if (closed) return;
    closed = true;
    ready = false;
    clearAuthTimer();
    openEvent = undefined;
    for (const { timer } of pending.values()) clearTimer(timer);
    pending.clear();
    onClose?.call(socket, event);
  };
}
