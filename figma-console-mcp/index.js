#!/usr/bin/env node
/**
 * figma-console-mcp
 * MCP server cho phép Claude gửi JS trực tiếp vào Figma Desktop plugin context
 * Transport: stdio (Claude Desktop) <-> WebSocket (Figma Plugin)
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { WebSocketServer, WebSocket } = require("ws");

const WS_PORT = 9988; // Port Figma plugin sẽ connect vào

// ── State ──────────────────────────────────────────────────────
let figmaSocket = null;       // WebSocket connection từ Figma plugin
const pendingCalls = new Map(); // callId -> { resolve, reject, timer }
let callIdCounter = 0;

// ── WebSocket Server (nhận kết nối từ Figma plugin) ────────────
const wss = new WebSocketServer({ port: WS_PORT });

wss.on("listening", () => {
  process.stderr.write(`[figma-console-mcp] WebSocket server listening on ws://localhost:${WS_PORT}\n`);
});

wss.on("connection", (ws) => {
  figmaSocket = ws;
  process.stderr.write("[figma-console-mcp] Figma plugin connected ✓\n");

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // msg = { id, result?, error? }
      const pending = pendingCalls.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingCalls.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
    } catch (e) {
      process.stderr.write(`[figma-console-mcp] Parse error: ${e.message}\n`);
    }
  });

  ws.on("close", () => {
    figmaSocket = null;
    process.stderr.write("[figma-console-mcp] Figma plugin disconnected\n");
    // Reject all pending calls
    for (const [id, pending] of pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Figma plugin disconnected"));
      pendingCalls.delete(id);
    }
  });

  ws.on("error", (err) => {
    process.stderr.write(`[figma-console-mcp] WS error: ${err.message}\n`);
  });
});

// ── Helper: send command to Figma, wait for result ─────────────
function sendToFigma(type, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!figmaSocket || figmaSocket.readyState !== WebSocket.OPEN) {
      return reject(new Error(
        "Figma plugin chưa kết nối. Mở Figma Desktop → Plugins → figma-console-bridge → Run"
      ));
    }

    const id = ++callIdCounter;
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`Timeout sau ${timeoutMs}ms — Figma plugin không phản hồi`));
    }, timeoutMs);

    pendingCalls.set(id, { resolve, reject, timer });
    figmaSocket.send(JSON.stringify({ id, type, payload }));
  });
}

// ── MCP Server ─────────────────────────────────────────────────
const server = new Server(
  { name: "figma-console-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "figma_eval",
      description: "Thực thi JavaScript trong Figma Plugin context. Code có full access vào figma.* API. Trả về kết quả dưới dạng string.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript code để chạy. Có thể dùng async/await. Giá trị return cuối cùng sẽ được trả về."
          },
          timeout: {
            type: "number",
            description: "Timeout tính bằng ms (mặc định 30000)"
          }
        },
        required: ["code"]
      }
    },
    {
      name: "figma_status",
      description: "Kiểm tra trạng thái kết nối với Figma Desktop plugin",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "figma_get_selection",
      description: "Lấy thông tin các node đang được select trong Figma",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "figma_get_page",
      description: "Lấy thông tin trang hiện tại (tên, id, danh sách children top-level)",
      inputSchema: { type: "object", properties: {} }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "figma_status": {
        const connected = figmaSocket && figmaSocket.readyState === WebSocket.OPEN;
        return {
          content: [{
            type: "text",
            text: connected
              ? "✅ Figma plugin đang kết nối (ws://localhost:" + WS_PORT + ")"
              : "❌ Chưa kết nối — Mở Figma Desktop → Plugins → figma-console-bridge → Run"
          }]
        };
      }

      case "figma_eval": {
        const code = args.code;
        const timeout = args.timeout || 30000;
        const result = await sendToFigma("eval", { code }, timeout);
        return {
          content: [{
            type: "text",
            text: result !== undefined && result !== null
              ? (typeof result === "string" ? result : JSON.stringify(result, null, 2))
              : "(undefined)"
          }]
        };
      }

      case "figma_get_selection": {
        const result = await sendToFigma("eval", {
          code: `
            const sel = figma.currentPage.selection;
            JSON.stringify(sel.map(n => ({
              id: n.id, name: n.name, type: n.type,
              x: Math.round(n.x), y: Math.round(n.y),
              width: Math.round(n.width), height: Math.round(n.height)
            })))
          `
        });
        return { content: [{ type: "text", text: result || "[]" }] };
      }

      case "figma_get_page": {
        const result = await sendToFigma("eval", {
          code: `
            const page = figma.currentPage;
            JSON.stringify({
              id: page.id,
              name: page.name,
              childCount: page.children.length,
              children: page.children.slice(0, 20).map(n => ({
                id: n.id, name: n.name, type: n.type,
                x: Math.round(n.x), y: Math.round(n.y)
              }))
            })
          `
        });
        return { content: [{ type: "text", text: result }] };
      }

      default:
        throw new Error(`Tool không tồn tại: ${name}`);
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `❌ Error: ${err.message}` }],
      isError: true
    };
  }
});

// ── Start ───────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[figma-console-mcp] MCP server started (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`[figma-console-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
