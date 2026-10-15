#!/usr/bin/env node
/**
 * figma-console-mcp
 * MCP server cho phép Claude gửi JS trực tiếp vào Figma Desktop plugin context
 * Transport: stdio (Claude Desktop) <-> WebSocket (Figma Plugin)
 *
 * Mỗi tool call là một phiên ngắn: mở port 9988 → chờ plugin kết nối → gửi lệnh
 * → nhận kết quả → đóng port. Nhờ vậy nhiều Claude (nhiều session/app) dùng chung
 * một plugin được: ai cần thì giữ port trong lúc gọi, người khác chờ đến lượt.
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { WebSocketServer } = require("ws");

// Bind đúng 127.0.0.1 như f2u.py: không mở ra LAN, và bind trùng địa chỉ mới báo EADDRINUSE.
// Bind wildcard (::) vẫn thành công song song với 127.0.0.1:9988 nên không biết port đang bận.
const WS_HOST = "127.0.0.1";
const WS_PORT = 9988;            // Port Figma plugin sẽ connect vào
const PORT_WAIT_MS = 60000;      // Chờ tối đa khi Claude khác đang giữ port
const PORT_RETRY_MS = 200;
const PLUGIN_WAIT_MS = 8000;     // Chờ plugin kết nối sau khi đã mở port (plugin thử lại mỗi 500ms)

const NOT_RUNNING_MSG =
  "Figma plugin chưa chạy. Mở Figma Desktop → Plugins → Development → figma-console-bridge → Run";

let callIdCounter = 0;
let queue = Promise.resolve();   // Các call trong cùng process chạy lần lượt

const log = (text) => process.stderr.write(`[figma-console-mcp] ${text}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// UI của plugin Figma chạy trong iframe có origin "null". Trang web bình thường gửi origin
// thật của nó nên bị chặn, không thể kết nối trước plugin rồi nhận lệnh / trả kết quả giả.
function verifyClient(info) {
  return info.origin === undefined || info.origin === "null";
}

// ── Mở port, thử lại nếu Claude khác đang giữ ──────────────────
function listenOnce() {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT, verifyClient });
    wss.once("listening", () => {
      wss.removeAllListeners("error");
      wss.on("error", (err) => log(`WS error: ${err.message}`));
      resolve(wss);
    });
    wss.once("error", (err) => {
      wss.close();
      reject(err);
    });
  });
}

async function openServer(portWaitMs) {
  const deadline = Date.now() + portWaitMs;
  for (;;) {
    try {
      return await listenOnce();
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
      if (Date.now() >= deadline) {
        throw new Error(`Port ${WS_PORT} vẫn bận sau ${portWaitMs}ms — có thể một Claude khác đang chạy lệnh dài`);
      }
      await sleep(PORT_RETRY_MS);
    }
  }
}

function waitForPlugin(wss, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(NOT_RUNNING_MSG)), ms);
    wss.once("connection", (ws) => {
      clearTimeout(timer);
      resolve(ws);
    });
  });
}

function request(ws, msg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout sau ${timeoutMs}ms — Figma plugin không phản hồi`)),
      timeoutMs
    );
    ws.on("message", (raw) => {
      let res;
      try {
        res = JSON.parse(raw.toString());
      } catch (e) {
        log(`Parse error: ${e.message}`);
        return;
      }
      if (res.id !== msg.id) return;
      clearTimeout(timer);
      if (res.error) reject(new Error(res.error));
      else resolve(res.result);
    });
    ws.on("close", () => {
      clearTimeout(timer);
      reject(new Error("Figma plugin ngắt kết nối giữa chừng"));
    });
    ws.send(JSON.stringify(msg));
  });
}

function closeServer(wss) {
  return new Promise((resolve) => {
    for (const client of wss.clients) {
      client.close(1000, "done");
      setTimeout(() => client.terminate(), 500).unref();
    }
    wss.close(() => resolve());
  });
}

// ── Một phiên: mở port → chờ plugin → gửi lệnh → đóng port ─────
async function runSession(type, payload, timeoutMs, opts) {
  const wss = await openServer(opts.portWaitMs);
  try {
    const ws = await waitForPlugin(wss, opts.pluginWaitMs);
    // Gửi kèm timeout để ui.html chờ đúng bằng thời gian này
    return await request(ws, { id: ++callIdCounter, type, payload, timeout: timeoutMs }, timeoutMs);
  } finally {
    await closeServer(wss);
  }
}

function sendToFigma(type, payload, timeoutMs = 30000, opts = {}) {
  const o = { portWaitMs: PORT_WAIT_MS, pluginWaitMs: PLUGIN_WAIT_MS, ...opts };
  const run = () => runSession(type, payload, timeoutMs, o);
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// ── MCP Server ─────────────────────────────────────────────────
const server = new Server(
  { name: "figma-console-mcp", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "figma_eval",
      description: "Thực thi JavaScript trong Figma Plugin context. Code có full access vào figma.* API. Code chạy như thân một async function: dùng `return` để trả kết quả (object sẽ được JSON.stringify).",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript code để chạy. Có thể dùng await. Phải `return` giá trị muốn lấy về."
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
      description: "Kiểm tra Figma Desktop plugin có đang chạy và trả lời được không",
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
        try {
          const info = await sendToFigma(
            "eval",
            { code: `return figma.root.name + " / " + figma.currentPage.name;` },
            5000,
            { portWaitMs: 10000, pluginWaitMs: 4000 }
          );
          return { content: [{ type: "text", text: `✅ Figma plugin đang chạy — file: ${info}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `❌ ${err.message}` }] };
        }
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
            })));
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
            });
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
  log("MCP server started (stdio) — port 9988 chỉ mở trong lúc gọi tool");
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
