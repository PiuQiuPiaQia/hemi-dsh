/**
 * The JavaScript half of the mobile transport bridge.
 *
 * Injected with `WKUserScript(injectionTime: .atDocumentStart,
 * forMainFrameOnly: true)` only for the paired origin. Installs
 * `window.__DSH_TRANSPORT__` with `createWebSocket` and `streamBaseUrl` per the
 * contract in `packages/client/connection/src/client/index.ts` (hooks) and
 * `socket.ts` (ConnectionWebSocket: text-only `send`, `close`, readyState, and
 * `addEventListener`/`removeEventListener` with `once`).
 *
 * Dispatch semantics (matching the WHATWG listener model): listeners are
 * invoked from a snapshot of the live list; entries removed by an earlier
 * callback are skipped, entries added during dispatch do not run until the
 * next event, and `once` entries leave the list before their invocation. A
 * late `open` never revives a closing or closed socket, and the registry entry
 * plus listener list are dropped after `close` so reconnection cycles do not
 * accumulate state; a released socket object still reports `readyState === 3`.
 *
 * The secret never appears here: authentication rides the HttpOnly cookie set
 * by `GET /mobile/session`, and the native socket adds its own Cookie header.
 */

import Foundation

/**
 * Render the bridge script for one origin.
 * @param origin - paired origin string used as `streamBaseUrl`.
 * @returns JavaScript source; safe to embed because callers pass a validated origin.
 */
public func bridgeScript(origin: String) -> String {
    let encoded = origin.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
    return """
    (function () {
      if (window.__DSH_TRANSPORT__) return;
      var sockets = {};
      var nextId = 1;
      var CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
      function post(message) {
        webkit.messageHandlers.dshSocket.postMessage(JSON.stringify(message));
      }
      function release(socket) {
        delete sockets[socket._id];
        socket._listeners = { open: [], error: [], close: [], message: [] };
      }
      function NativeSocket(url) {
        var socket = this;
        socket._id = String(nextId++);
        socket._state = CONNECTING;
        socket._listeners = { open: [], error: [], close: [], message: [] };
        sockets[socket._id] = socket;
        socket.readyState = CONNECTING;
        socket.send = function (data) {
          if (typeof data !== 'string') throw new TypeError('dsh mobile bridge: text frames only');
          if (socket._state !== OPEN) throw new Error('dsh mobile bridge: socket is not open');
          post({ id: socket._id, op: 'send', data: data });
        };
        socket.close = function (code, reason) {
          if (socket._state === CLOSED) return;
          socket._state = CLOSING;
          socket.readyState = CLOSING;
          post({ id: socket._id, op: 'close', code: (code == null ? 1000 : code), reason: String(reason == null ? '' : reason) });
        };
        socket.addEventListener = function (type, listener, options) {
          if (!socket._listeners[type] || typeof listener !== 'function') return;
          socket._listeners[type].push({ fn: listener, once: !!(options && options.once) });
        };
        socket.removeEventListener = function (type, listener) {
          var list = socket._listeners[type];
          if (!list) return;
          for (var i = list.length - 1; i >= 0; i--) {
            if (list[i].fn === listener) list.splice(i, 1);
          }
        };
        post({ id: socket._id, op: 'open', url: String(url) });
      }
      window.__dshNativeSocketDispatch = function (id, type, payload) {
        var socket = sockets[id];
        if (!socket) return;
        if (type === 'open') {
          // A late open after close() or a close event must not revive the socket.
          if (socket._state !== CONNECTING) return;
          socket._state = OPEN;
          socket.readyState = OPEN;
        } else if (type === 'close') {
          if (socket._state === CLOSED) return;
          socket._state = CLOSED;
          socket.readyState = CLOSED;
        }
        if (type === 'message' && socket._state !== OPEN) return;
        var event = {};
        if (type === 'message') event.data = payload;
        var live = socket._listeners[type];
        if (!live) return;
        var snapshot = live.slice();
        for (var i = 0; i < snapshot.length; i++) {
          var entry = snapshot[i];
          var index = live.indexOf(entry);
          if (index < 0) continue;
          if (entry.once) live.splice(index, 1);
          try { entry.fn(event); } catch (e) { /* listener errors stay page-local */ }
        }
        if (type === 'close') release(socket);
      };
      window.__dshNativeSocketCount = function () { return Object.keys(sockets).length; };
      window.__DSH_TRANSPORT__ = {
        createWebSocket: function (url) { return new NativeSocket(String(url)); },
        streamBaseUrl: '\(encoded)'
      };
    })();
    """
}
