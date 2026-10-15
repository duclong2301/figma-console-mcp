#!/usr/bin/env node
/**
 * figma-console-mcp
 * MCP server that lets Claude run JavaScript directly in the Figma Desktop plugin context
 * Transport: stdio (Claude) <-> WebSocket (Figma plugin)
 *
 * Each tool call is a short session: open port 9988 → wait for the plugin to connect → send
 * the command → receive the result → close the port. This lets several Claude sessions/apps
 * share one plugin: whoever needs it holds the port for the call, everyone else waits their turn.
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { WebSocketServer } = require("ws");

// Bind exactly 127.0.0.1: the port stays off the LAN, and only a bind to the same address reports
// EADDRINUSE. A wildcard (::) bind still succeeds next to 127.0.0.1:9988, so a busy port would go unnoticed.
const WS_HOST = "127.0.0.1";
const WS_PORT = 9988;            // Port the Figma plugin connects to
const PORT_WAIT_MS = 60000;      // Max wait while another Claude session holds the port
const PORT_RETRY_MS = 200;
const PLUGIN_WAIT_MS = 8000;     // Wait for the plugin after opening the port (it retries every 500ms)

const NOT_RUNNING_MSG =
  "Figma plugin is not running. In Figma Desktop: Plugins → Development → figma-console-bridge → Run";

let callIdCounter = 0;
let queue = Promise.resolve();   // Calls within one process run one at a time

const log = (text) => process.stderr.write(`[figma-console-mcp] ${text}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Figma plugin UI runs in an iframe with a "null" origin. Regular web pages send their real
// origin and are rejected, so they cannot connect before the plugin and receive commands or fake results.
function verifyClient(info) {
  return info.origin === undefined || info.origin === "null";
}

// ── Open the port, retrying while another Claude session holds it ──
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
        throw new Error(`Port ${WS_PORT} still busy after ${portWaitMs}ms — another Claude session may be running a long command`);
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
      () => reject(new Error(`Timed out after ${timeoutMs}ms — Figma plugin did not respond`)),
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
      reject(new Error("Figma plugin disconnected mid-call"));
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

// ── One session: open port → wait for plugin → send command → close port ──
async function runSession(type, payload, timeoutMs, opts) {
  const wss = await openServer(opts.portWaitMs);
  try {
    const ws = await waitForPlugin(wss, opts.pluginWaitMs);
    // Send the timeout along so ui.html waits exactly as long
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
      description: "Run JavaScript in the Figma plugin context with full access to the figma.* Plugin API. The code runs as the body of an async function: use `return` to send back a result (objects are JSON.stringify'd).",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript to run. `await` is allowed. You must `return` the value you want back."
          },
          timeout: {
            type: "number",
            description: "Timeout in ms (default 30000)"
          }
        },
        required: ["code"]
      }
    },
    {
      name: "figma_status",
      description: "Check that the Figma Desktop plugin is running and responding",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "figma_get_selection",
      description: "Get the nodes currently selected in Figma (id, name, type, position, size)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "figma_get_page",
      description: "Get the current page (name, id, top-level children)",
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
          return { content: [{ type: "text", text: `✅ Figma plugin is running — file: ${info}` }] };
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
        throw new Error(`Unknown tool: ${name}`);
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
  log("MCP server started (stdio) — port 9988 opens only during tool calls");
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
