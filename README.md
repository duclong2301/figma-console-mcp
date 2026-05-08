# figma-console-mcp

Figma MCP server via plugin bridge — no REST API, no rate limits. Turn text into designs and designs into real code. Works with Cursor, Claude, GitHub Copilot, and any MCP-compatible AI tool.

> **Credits / Nguồn gốc:** Dự án này được xây dựng dựa trên ý tưởng và kiến trúc từ [**vkhanhqui/figma-mcp-go**](https://github.com/vkhanhqui/figma-mcp-go) — một MCP server Figma mã nguồn mở không dùng REST API. Mọi công sức sáng tạo thuộc về tác giả gốc.

---

## Tại sao tồn tại

Hầu hết các Figma MCP server đều dựa vào **Figma REST API** — và bị giới hạn nghiêm ngặt:

| Plan | Giới hạn |
|------|-----------|
| Starter / View / Collab | **6 lần gọi/tháng** |
| Pro / Org (Dev seat) | 200 lần/ngày |
| Enterprise | 600 lần/ngày |

Dự án này **không dùng REST API**. Thay vào đó, giao tiếp trực tiếp với Figma thông qua plugin bridge — miễn phí, không giới hạn tốc độ.

---

## Điểm nổi bật

- Không cần Figma API token
- Không bị giới hạn rate limit — thân thiện với gói miễn phí
- **Đọc và Ghi** dữ liệu Figma trực tiếp qua plugin bridge
- Tự động hoá thiết kế: styles, variables, components, prototypes, content
- Hỗ trợ: Cursor, Claude, GitHub Copilot, và mọi AI tool tương thích MCP
- **Khi bật tính năng tương tác trực tiếp với Figma console:** server đăng ký và gửi toàn bộ **120 tool** đến AI client trong một lần duy nhất — thay vì gửi từng tool một như bản gốc (`figma-mcp-go`), giúp khởi tạo nhanh hơn và không bỏ sót tool nào

---

## Cài đặt

### 1. Chạy MCP server

```bash
node index.js
```

Hoặc cấu hình trong MCP client:

**.mcp.json** (Claude và các tool tương thích MCP)
```json
{
  "mcpServers": {
    "figma-console-mcp": {
      "command": "node",
      "args": ["/path/to/figma-console-mcp/index.js"]
    }
  }
}
```

**.vscode/mcp.json** (Cursor / VS Code / GitHub Copilot)
```json
{
  "servers": {
    "figma-console-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/figma-console-mcp/index.js"]
    }
  }
}
```

### 2. Cài Figma plugin

1. Mở Figma Desktop: **Plugins → Development → Import plugin from manifest**
2. Chọn file `plugin/manifest.json` trong thư mục này
3. Chạy plugin bên trong một file Figma bất kỳ
4. Giữ plugin mở trong khi dùng MCP server

---

## Cấu trúc dự án

```
figma-console-mcp/
├── index.js              # MCP server chính (Node.js)
├── package.json
├── package-lock.json
└── plugin/
    ├── manifest.json     # Manifest của Figma plugin
    ├── code.js           # Logic plugin (chạy trong Figma sandbox)
    └── ui.html           # Giao diện plugin (panel)
```

---

## Cách hoạt động

```
 AI Tool (Claude, Cursor, ...)
       │  MCP protocol (stdio)
       ▼
  index.js (MCP Server)
       │  WebSocket
       ▼
  Figma Plugin (plugin/code.js)
       │  Figma Plugin API
       ▼
  Figma Document
```

MCP server nhận lệnh từ AI tool qua stdio, chuyển đến Figma plugin qua WebSocket. Plugin thực thi trực tiếp trong Figma mà không cần REST API.

---

## Nguồn gốc & Attribution

Dự án này là một phiên bản Node.js, lấy cảm hứng và kiến trúc từ:

- **[vkhanhqui/figma-mcp-go](https://github.com/vkhanhqui/figma-mcp-go)** — Go-based Figma MCP server, tác giả gốc của ý tưởng plugin bridge không dùng REST API.

Mọi công nhận xứng đáng thuộc về tác giả gốc. Dự án này chỉ là một adaptation cho môi trường Node.js.

---

## License

MIT — xem file [LICENSE](LICENSE) để biết thêm.
