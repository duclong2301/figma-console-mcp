# figma-console-mcp

Cho phép Claude gửi JavaScript trực tiếp vào Figma Desktop plugin context — không giới hạn rate, không cần tool call riêng lẻ.

## Architecture

```
Claude Desktop
    ↕ stdio (MCP)
Node.js MCP Server (index.js)  ← port 9988 WebSocket →  Figma Desktop Plugin (code.js)
                                                                ↕
                                                          figma.* Plugin API
```

---

## Setup (3 bước)

### Bước 1 — Cài MCP server

```bash
# Copy thư mục này vào máy Windows của bạn, ví dụ:
# F:\Tools\figma-console-mcp\

cd F:\Tools\figma-console-mcp
npm install
```

### Bước 2 — Đăng ký plugin trong Figma Desktop

1. Mở Figma Desktop
2. Menu → **Plugins** → **Development** → **Import plugin from manifest...**
3. Chọn file `plugin/manifest.json`
4. Plugin `figma-console-bridge` sẽ xuất hiện trong danh sách

### Bước 3 — Thêm vào Claude Desktop config

Mở `%APPDATA%\Claude\claude_desktop_config.json`, thêm:

```json
{
  "mcpServers": {
    "figma-mcp-go": {
      "command": "F:\\Downloads\\pluginfigma\\plugin\\figma-mcp-go.exe"
    },
    "figma-console": {
      "command": "node",
      "args": ["F:\\Tools\\figma-console-mcp\\index.js"]
    }
  }
}
```

Restart Claude Desktop.

---

## Cách dùng

### Mỗi lần làm việc

1. Mở file Figma cần chỉnh
2. **Plugins** → **Development** → **figma-console-bridge** → **Run**
3. Panel nhỏ hiện ra, chờ "✅ Connected to Claude MCP"
4. Chat với Claude như bình thường

### Tools có sẵn cho Claude

| Tool | Mô tả |
|------|-------|
| `figma_eval` | Chạy JS bất kỳ trong Figma context |
| `figma_status` | Kiểm tra kết nối |
| `figma_get_selection` | Lấy thông tin node đang select |
| `figma_get_page` | Lấy cấu trúc trang hiện tại |

### Ví dụ Claude có thể làm

```js
// Đổi màu tất cả text node trên trang
figma.currentPage.findAll(n => n.type === 'TEXT')
  .forEach(n => n.fills = [{type:'SOLID', color:{r:0.1,g:0.37,b:0.64}}])
```

```js
// Lấy tất cả frame names
JSON.stringify(figma.currentPage.children.map(n => n.name))
```

```js
// Tạo component nhanh từ selection
const sel = figma.currentPage.selection[0]
figma.createComponentFromNode(sel)
```

---

## Notes

- Plugin tự reconnect nếu mất kết nối
- Timeout mặc định 30s per call  
- `async/await` được support trong code gửi lên
- Kết quả trả về dưới dạng JSON string
