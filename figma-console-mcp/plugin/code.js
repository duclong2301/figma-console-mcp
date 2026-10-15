/**
 * figma-console-bridge — code.js (Plugin Sandbox)
 *
 * No WebSocket here — the plugin sandbox does not support it.
 * The WebSocket lives in ui.html (iframe).
 *
 * Flow:
 *   MCP Server <--WS--> ui.html <--postMessage--> code.js <--figma API-->
 */

figma.showUI(__html__, { width: 280, height: 180, title: "Console Bridge" });

// Receive commands from ui.html, run them against the figma API, send results back to ui.html
figma.ui.onmessage = async function(msg) {
  if (msg.type !== "eval") return;

  var id = msg.id;
  var code = msg.code;

  try {
    // Function constructor instead of eval, so the code can use await.
    // The code is a function body, so it needs `return` to produce a result. The newlines on
    // both sides keep a trailing `//` comment from swallowing the closing `})()`.
    var fn = new Function("return (async () => {\n" + code + "\n})()");
    var result = await fn();

    var serialized;
    if (result === undefined || result === null) {
      serialized = null;
    } else if (typeof result === "string") {
      serialized = result;
    } else {
      try {
        serialized = JSON.stringify(result, null, 2);
      } catch (e2) {
        serialized = String(result);
      }
    }

    figma.ui.postMessage({ type: "result", id: id, result: serialized });

  } catch (err) {
    figma.ui.postMessage({ type: "result", id: id, error: err.message || String(err) });
  }
};

figma.on("close", function() {
  figma.ui.postMessage({ type: "close" });
});
