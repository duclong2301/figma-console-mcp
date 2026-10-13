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

macOS (cần Node: `brew install node`). Code nằm trong thư mục con `figma-console-mcp/`:

```bash
cd ~/Desktop/Tools/figma-console-mcp/figma-console-mcp
npm ci
```

### Bước 2 — Đăng ký plugin trong Figma Desktop

1. Mở Figma Desktop
2. Menu → **Plugins** → **Development** → **Import plugin from manifest...**
3. Chọn file `plugin/manifest.json` (macOS: `~/Desktop/Tools/figma-console-mcp/figma-console-mcp/plugin/manifest.json`)
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

#### macOS — Claude Code, chỉ bật khi cần

Đã đăng ký thì mỗi session Claude Code mở ra đều tự chạy server, nên chỉ thêm khi cần dùng rồi gỡ khi xong.
Thêm hoặc gỡ xong thì mở session mới để có hiệu lực.

```bash
# Bật
claude mcp add --scope user figma-console -- /opt/homebrew/bin/node ~/Desktop/Tools/figma-console-mcp/figma-console-mcp/index.js

# Tắt
claude mcp remove --scope user figma-console
```

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
return figma.currentPage.children.map(n => n.name)
```

```js
// Tạo component nhanh từ selection
const sel = figma.currentPage.selection[0]
return figma.createComponentFromNode(sel).id
```

---

## Notes

- Code gửi lên là thân của một hàm async: phải `return` giá trị muốn lấy, không có `return` thì nhận `(undefined)`
- Plugin tự reconnect nếu mất kết nối
- Timeout mặc định 30s per call, đổi bằng tham số `timeout` của `figma_eval` (plugin chờ đúng bằng thời gian đó)
- `async/await` được support trong code gửi lên
- Kết quả trả về dưới dạng JSON string
- WebSocket chỉ nghe trên `127.0.0.1:9988` và chỉ nhận kết nối có origin `null` (iframe của plugin) hoặc không có origin, nên trang web thường không chiếm được kết nối
- Nhiều session Claude cùng chạy: session mở port trước sẽ dùng được, các session sau báo "Port 9988 đang bị ... giữ" và tự nhận port khi session kia tắt
- Mở plugin ở nhiều file Figma: kết nối mới nhất được dùng, đóng nó thì chuyển về kết nối còn lại
