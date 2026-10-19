# figma-console-mcp

An MCP server that lets Claude (Claude Code, Claude Desktop or any MCP client) run JavaScript directly inside Figma Desktop through a plugin, with the full `figma.*` Plugin API. No Figma REST API, no access token, no rate limits.

## How it works

```
Claude (Code / Desktop)
    ↕ stdio (MCP)
index.js (MCP server)  ◀── ws://127.0.0.1:9988 ──  plugin/ui.html (plugin iframe)
                                                        ↕ postMessage
                                                   plugin/code.js
                                                        ↕
                                                   figma.* Plugin API
```

The server **opens port 9988 only for the duration of a tool call**: open the port → wait for the plugin to connect (up to 8s) → send the command → receive the result → close the port. Because an idle server holds no port, several Claude sessions, and other tools that use the same port, can take turns sharing one plugin. A call made while the port is busy waits for its turn (up to 60s).

---

## Installation

### 1. Install Node.js and the dependencies

Requires Node.js 18 or later (macOS: `brew install node`; Windows: install from nodejs.org). The code lives in the `figma-console-mcp/` subfolder:

```bash
cd figma-console-mcp
npm ci
```

### 2. Import the plugin into Figma Desktop

1. Open Figma Desktop (development plugins do not run in Figma for the web)
2. **Plugins** → **Development** → **Import plugin from manifest...**
3. Select `figma-console-mcp/plugin/manifest.json`
4. The `figma-console-bridge` plugin now appears in the list

### 3. Register the MCP server

**Claude Code**

```bash
claude mcp add --scope user figma-console -- node /path/to/figma-console-mcp/figma-console-mcp/index.js
```

Remove it with `claude mcp remove --scope user figma-console`. Changes take effect in new sessions. If the app cannot find `node` on its PATH, use the absolute path (for example `/opt/homebrew/bin/node` for a Homebrew install on Apple Silicon).

**Claude Desktop**: add the server to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "figma-console": {
      "command": "node",
      "args": ["/path/to/figma-console-mcp/figma-console-mcp/index.js"]
    }
  }
}
```

On Windows, escape backslashes in the path, for example `"F:\\Tools\\figma-console-mcp\\figma-console-mcp\\index.js"`.

---

## Usage

1. Open the Figma file you want to work on and run **Plugins** → **Development** → **figma-console-bridge**. Keep the plugin open while you work.
2. The panel shows **"Idle — waiting for Claude"** between calls and **"⚡ Running command from Claude..."** while a command runs. Idle is normal: the plugin retries every 500ms and can only connect while Claude is calling a tool.
3. Work with Claude as usual. Call `figma_status` to check that the plugin responds.

### Tools

| Tool | Description |
|------|-------------|
| `figma_eval` | Run JavaScript in the plugin context. Parameters: `code` (required) and `timeout` in ms (default 30000) |
| `figma_status` | Send a test command to the plugin; returns the open file and page, or why the plugin could not be reached |
| `figma_get_selection` | id, name, type, position and size of the selected nodes |
| `figma_get_page` | Current page: id, name, child count and the first 20 top-level children |

### Writing code for `figma_eval`

- The code is the body of an async function: `await` is allowed, and you **must `return`** the value you want back. Without `return` the result is `(undefined)`.
- Objects are returned as `JSON.stringify` output; strings are returned as is.
- A thrown error becomes an error result carrying its message.

```js
// Recolor every text node on the page and return how many changed
const texts = figma.currentPage.findAll(n => n.type === 'TEXT')
texts.forEach(n => n.fills = [{ type: 'SOLID', color: { r: 0.1, g: 0.37, b: 0.64 } }])
return texts.length
```

```js
// Names of all top-level nodes
return figma.currentPage.children.map(n => n.name)
```

```js
// Change text content: load the font first
const t = figma.currentPage.selection[0]
await figma.loadFontAsync(t.fontName)
t.characters = 'Play'
return t.id
```

```js
// Turn the selected node into a component
const sel = figma.currentPage.selection[0]
return figma.createComponentFromNode(sel).id
```

---

## Notes

- **Security:** the port listens on `127.0.0.1` only and accepts only connections with a `null` origin (the plugin iframe) or no origin. Other machines on the LAN and regular web pages cannot connect.
- **Other tools sharing port 9988** should also bind `127.0.0.1`, not `0.0.0.0` or `::`. A wildcard bind still succeeds alongside `127.0.0.1:9988`, so neither side would notice the port is busy.
- With the plugin open in several Figma files, the command runs in whichever plugin connects first.
- When `timeout` expires the tool reports an error, but code already running in Figma is not cancelled.
- Commands sent through the same server run one at a time, never in parallel.

## Troubleshooting

| Message | Cause and fix |
|---------|---------------|
| `Figma plugin is not running...` | The plugin is not open, or it is connected to another server on the same port. Run the plugin again. |
| `Port 9988 still busy after ...ms` | Another process has held the port too long: usually an older server version (which kept the port open permanently, before the per-call model) or another script. Find it with `lsof -nP -iTCP:9988 -sTCP:LISTEN` (macOS) or `netstat -ano \| findstr :9988` (Windows). For an older server, reconnect the MCP server in that session or stop the process. |
| `Timed out after ...ms` | The code ran longer than `timeout`. Raise `timeout` or split the work into smaller commands. |

---

## Credits

The plugin-bridge approach without the REST API was inspired by the figma-mcp-go project by vkhanhqui.

## License

MIT — see [LICENSE](LICENSE).
