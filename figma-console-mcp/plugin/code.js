/**
 * figma-console-bridge — Figma Desktop Plugin
 * Kết nối WebSocket về figma-console-mcp server,
 * nhận lệnh JS và thực thi trong Figma Plugin context.
 *
 * File này là plugin/code.js
 */

const WS_URL = "ws://localhost:9988";
const RECONNECT_DELAY = 3000;

figma.showUI(__html__, { width: 280, height: 160, title: "Console Bridge" });

let ws = null;

function connect() {
  figma.ui.postMessage({ type: "status", text: "Connecting...", color: "#F59E0B" });

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    figma.ui.postMessage({ type: "status", text: "✅ Connected to Claude MCP", color: "#10B981" });
    figma.notify("figma-console-bridge: Connected ✓", { timeout: 2000 });
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    const { id, type, payload } = msg;

    if (type === "eval") {
      try {
        // Wrap code trong async IIFE để support await
        const wrappedCode = `(async () => { ${payload.code} })()`;
        // eslint-disable-next-line no-eval
        const result = await eval(wrappedCode);

        let serialized;
        if (result === undefined || result === null) {
          serialized = null;
        } else if (typeof result === "string") {
          serialized = result;
        } else {
          try {
            serialized = JSON.stringify(result, null, 2);
          } catch {
            serialized = String(result);
          }
        }

        ws.send(JSON.stringify({ id, result: serialized }));
        figma.ui.postMessage({ type: "log", text: `✓ exec #${id}` });
      } catch (err) {
        ws.send(JSON.stringify({ id, error: err.message || String(err) }));
        figma.ui.postMessage({ type: "log", text: `✗ #${id}: ${err.message}`, color: "#EF4444" });
      }
    }
  };

  ws.onerror = () => {
    figma.ui.postMessage({ type: "status", text: "❌ Connection error", color: "#EF4444" });
  };

  ws.onclose = () => {
    figma.ui.postMessage({ type: "status", text: `Reconnecting in ${RECONNECT_DELAY / 1000}s...`, color: "#9CA3AF" });
    setTimeout(connect, RECONNECT_DELAY);
  };
}

connect();

figma.on("close", () => {
  if (ws) ws.close();
});
