/**
 * figma-console-bridge — code.js (Plugin Sandbox)
 *
 * KHÔNG có WebSocket ở đây — sandbox không support.
 * WebSocket chạy trong ui.html (iframe).
 *
 * Flow:
 *   MCP Server <--WS--> ui.html <--postMessage--> code.js <--figma API-->
 */

figma.showUI(__html__, { width: 280, height: 180, title: "Console Bridge" });

// Nhận lệnh từ ui.html, thực thi figma API, trả kết quả về ui.html
figma.ui.onmessage = async function(msg) {
  if (msg.type !== "eval") return;

  var id = msg.id;
  var code = msg.code;

  try {
    // Dùng Function constructor thay vì eval — support await
    var fn = new Function("return (async () => { " + code + " })()");
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
