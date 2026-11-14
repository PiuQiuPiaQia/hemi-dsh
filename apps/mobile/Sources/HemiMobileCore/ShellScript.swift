/**
 * The page-facing shell control script: installs `window.__HEMI_MOBILE__` and
 * one owned scroll-containment style sheet.
 *
 * Injected next to the transport bridge with `WKUserScript(injectionTime:
 * .atDocumentStart, forMainFrameOnly: true)`. The global is the read-only
 * capability surface the served Web UI uses for shell integration: the paired
 * server display name and a disconnect action. It carries no origin, secret,
 * or token — authentication stays in the HttpOnly cookie and the Keychain.
 *
 * `disconnect()` posts exactly one fixed message through the existing
 * `dshSocket` handler. The native side routes it only after the same
 * `OriginPolicy.bridgeEligible` guard as socket commands, so subframes and
 * foreign origins cannot disconnect, a torn-down screen ignores it, and the
 * payload's missing `id` makes it undecodable as a socket command even if it
 * were ever forwarded.
 *
 * The script also installs `MobileShellScrollStyle`: one `<style>` element
 * that turns off overscroll chaining on the served app's conversation scroll
 * host and the outer `html`/`body` chain, so momentum at the transcript ends
 * cannot rubber-band inside the chat flow even though the outer WKScrollView
 * already stopped bouncing. The document-start injection runs before `<head>`
 * exists, so installation waits once for `DOMContentLoaded`; the element id
 * makes re-injection idempotent, and nothing observes the page afterwards.
 */

import Foundation

/** Native-side constants shared by the generated script and its handler. */
public enum MobileShellCommand {
    /**
     * Exact `dshSocket` body posted by `__HEMI_MOBILE__.disconnect()`.
     * A fixed constant, so the native side can compare the whole message
     * instead of parsing page-controlled JSON.
     */
    public static let disconnectPayload = #"{"op":"hemiMobileDisconnect"}"#
}

/**
 * The one style sheet the shell script installs into the served document: the
 * native scroll-containment policy for the paired Web app's transcript.
 */
public enum MobileShellScrollStyle {
    /** The `<style>` element id; its presence in the document means installed. */
    public static let elementID = "hemi-mobile-scroll-style"

    /** Attribute naming this shell as the element's owner. */
    public static let ownerAttributeName = "data-hemi-mobile"

    /** Value of `ownerAttributeName` on the installed style element. */
    public static let ownerAttributeValue = "scroll"

    /**
     * CSS text. `overscroll-behavior-y: none` on the conversation scroll host
     * (`[data-conversation-scroll]`, the served app's transcript scrollport)
     * and on the outer `html`/`body` chain stops scroll chaining and the
     * WebKit rubber-band at both transcript ends. Only these two rules exist:
     * no wildcard selector, and in-process nested scrollers (group seats,
     * navigator, text areas) keep their own `overscroll-behavior`, so their
     * scrolling is unchanged.
     */
    public static let css = """
        html,body{overscroll-behavior-y:none!important}
        [data-conversation-scroll]{overscroll-behavior-y:none!important}
        """
}

/**
 * Render the shell control script for one paired server.
 * @param serverName - display name shown by the Web settings page.
 * @returns JavaScript source installing the frozen `__HEMI_MOBILE__` global
 *   and scheduling the scroll-containment style installation.
 */
public func shellScript(serverName: String) -> String {
    let encoded = javaScriptStringLiteral(serverName)
    let styleID = javaScriptStringLiteral(MobileShellScrollStyle.elementID)
    let ownerAttribute = javaScriptStringLiteral(MobileShellScrollStyle.ownerAttributeName)
    let ownerValue = javaScriptStringLiteral(MobileShellScrollStyle.ownerAttributeValue)
    let css = javaScriptStringLiteral(MobileShellScrollStyle.css)
    return """
    (function () {
      if (!window.__HEMI_MOBILE__) {
        var shell = Object.freeze({
          version: 1,
          serverName: \(encoded),
          disconnect: function () {
            webkit.messageHandlers.dshSocket.postMessage('\(MobileShellCommand.disconnectPayload)');
          }
        });
        Object.defineProperty(window, '__HEMI_MOBILE__', {
          value: shell,
          writable: false,
          enumerable: true,
          configurable: false
        });
      }
      if (typeof document === 'undefined') return;
      function installScrollStyle() {
        if (document.getElementById(\(styleID))) return;
        var style = document.createElement('style');
        style.id = \(styleID);
        style.setAttribute(\(ownerAttribute), \(ownerValue));
        style.textContent = \(css);
        (document.head || document.documentElement).appendChild(style);
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installScrollStyle, { once: true });
      } else {
        installScrollStyle();
      }
    })();
    """
}

/**
 * One string as a JavaScript/JSON string literal.
 * JSON escaping cannot terminate the literal: quotes, backslashes, control
 * characters, and line separators are encoded, so page-controlled text (the
 * server name) cannot inject script.
 * @param value - text to embed.
 * @returns quoted literal, e.g. `"a\"b"`.
 */
private func javaScriptStringLiteral(_ value: String) -> String {
    guard let data = try? JSONEncoder().encode(value),
          let literal = String(data: data, encoding: .utf8) else {
        // JSONEncoder cannot fail on a String input; the fallback stays a
        // valid literal so the generated script can never become invalid.
        return "\"\""
    }
    return literal
}
