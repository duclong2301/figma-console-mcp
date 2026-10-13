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

const WS_HOST = "127.0.0.1"; // Chỉ nhận kết nối từ chính máy này, không mở ra LAN
const WS_PORT = 9988; // Port Figma plugin sẽ connect vào
const WS_RETRY_MS = 5000; // Port đang bị instance khác giữ → thử lại sau mỗi 5s

// ── State ──────────────────────────────────────────────────────
let figmaSocket = null;       // WebSocket connection từ Figma plugin (kết nối mới nhất)
const figmaSockets = new Set(); // Mọi plugin đang kết nối, theo thứ tự kết nối
let wsListenError = null;     // Lý do chưa mở được port (vd. EADDRINUSE), null khi đang listen
const pendingCalls = new Map(); // callId -> { resolve, reject, timer, ws }
let callIdCounter = 0;

// ── WebSocket Server (nhận kết nối từ Figma plugin) ────────────
// UI của plugin Figma chạy trong iframe có origin "null". Trang web bình thường gửi origin
// thật của nó nên bị chặn, không chiếm được kết nối hay trả kết quả giả về cho Claude.
function verifyClient(info) {
  return info.origin === undefined || info.origin === "null";
}

function startWebSocketServer() {
  const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT, verifyClient });

  wss.on("listening", () => {
    wsListenError = null;
    process.stderr.write(`[figma-console-mcp] WebSocket server listening on ws://${WS_HOST}:${WS_PORT}\n`);
  });

  // Không có handler này thì EADDRINUSE (session Claude khác đang chạy figma-console-mcp)
  // làm crash cả MCP server. Giữ MCP sống và thử lại cho tới khi port được nhả.
  wss.on("error", (err) => {
    wsListenError = err.code === "EADDRINUSE"
      ? `Port ${WS_PORT} đang bị một figma-console-mcp khác giữ (session Claude khác)`
      : `WebSocket server lỗi: ${err.message}`;
    process.stderr.write(`[figma-console-mcp] ${wsListenError}, thử lại sau ${WS_RETRY_MS / 1000}s\n`);
    wss.close();
    setTimeout(startWebSocketServer, WS_RETRY_MS);
  });

  wss.on("connection", onFigmaConnection);
}

function onFigmaConnection(ws) {
  // Kết nối mới nhất được dùng (vd. chạy lại plugin, hoặc mở plugin ở file Figma khác)
  figmaSockets.add(ws);
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
    figmaSockets.delete(ws);
    // Chỉ reject các call đã gửi qua socket này
    for (const [id, pending] of pendingCalls) {
      if (pending.ws !== ws) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error("Figma plugin disconnected"));
      pendingCalls.delete(id);
    }
    // Socket cũ đóng không được ngắt socket đang dùng
    if (figmaSocket !== ws) return;
    figmaSocket = [...figmaSockets].pop() || null;
    process.stderr.write(figmaSocket
      ? "[figma-console-mcp] Figma plugin disconnected, chuyển sang plugin còn lại\n"
      : "[figma-console-mcp] Figma plugin disconnected\n");
  });

  ws.on("error", (err) => {
    process.stderr.write(`[figma-console-mcp] WS error: ${err.message}\n`);
  });
}

startWebSocketServer();

// ── Helper: send command to Figma, wait for result ─────────────
function sendToFigma(type, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!figmaSocket || figmaSocket.readyState !== WebSocket.OPEN) {
      return reject(new Error(wsListenError
        ? `${wsListenError}. Dùng figma-console ở session đó, hoặc đóng session đó rồi thử lại`
        : "Figma plugin chưa kết nối. Mở Figma Desktop → Plugins → figma-console-bridge → Run"
      ));
    }

    const id = ++callIdCounter;
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`Timeout sau ${timeoutMs}ms — Figma plugin không phản hồi`));
    }, timeoutMs);

    pendingCalls.set(id, { resolve, reject, timer, ws: figmaSocket });
    // Gửi kèm timeout để ui.html chờ đúng bằng thời gian này
    figmaSocket.send(JSON.stringify({ id, type, payload, timeout: timeoutMs }));
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
      description: "Thực thi JavaScript trong Figma Plugin context. Code có full access vào figma.* API. Code chạy trong thân một hàm async: phải dùng `return` để lấy kết quả (không có `return` thì nhận (undefined)). Object được trả về dưới dạng JSON string.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript code để chạy, là thân của một hàm async: dùng được await, kết thúc bằng `return <giá trị>` để lấy kết quả. Ví dụ: `return figma.currentPage.children.map(n => n.name)`"
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
              : wsListenError
                ? `❌ ${wsListenError} — session này chưa dùng được figma-console, đang thử lại`
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
            return JSON.stringify(sel.map(n => ({
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
            return JSON.stringify({
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
        return { content: [{ type: "text", text: result || "{}" }] };
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
