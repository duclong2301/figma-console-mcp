# figma-console-mcp

MCP server cho phép Claude (Claude Code, Claude Desktop hoặc client MCP bất kỳ) chạy JavaScript trực tiếp trong Figma Desktop qua một plugin, với toàn bộ `figma.*` Plugin API. Không dùng Figma REST API, không cần token, không bị giới hạn rate.

## Cách hoạt động

```
Claude (Code / Desktop)
    ↕ stdio (MCP)
index.js (MCP server)  ◀── ws://127.0.0.1:9988 ──  plugin/ui.html (iframe của plugin)
                                                        ↕ postMessage
                                                   plugin/code.js
                                                        ↕
                                                   figma.* Plugin API
```

Server **chỉ mở port 9988 trong lúc chạy một tool call**: mở port → chờ plugin kết nối (tối đa 8s) → gửi lệnh → nhận kết quả → đóng port. Khi rảnh server không giữ port, nên nhiều session Claude và các tool khác dùng cùng port thay phiên nhau dùng chung một plugin. Gọi lúc port đang bận thì chờ tới lượt (tối đa 60s).

---

## Cài đặt

### 1. Cài Node.js và dependency

Cần Node.js 18 trở lên (macOS: `brew install node`, Windows: cài từ nodejs.org). Code nằm trong thư mục con `figma-console-mcp/`:

```bash
cd figma-console-mcp
npm ci
```

### 2. Import plugin vào Figma Desktop

1. Mở Figma Desktop (plugin development không chạy trên Figma web)
2. **Plugins** → **Development** → **Import plugin from manifest...**
3. Chọn `figma-console-mcp/plugin/manifest.json`
4. Plugin `figma-console-bridge` xuất hiện trong danh sách

### 3. Đăng ký MCP server

**Claude Code**

```bash
claude mcp add --scope user figma-console -- node /path/to/figma-console-mcp/figma-console-mcp/index.js
```

Gỡ bằng `claude mcp remove --scope user figma-console`. Thêm hoặc gỡ xong thì mở session mới để có hiệu lực. Nếu app không tìm thấy `node` trong PATH, dùng đường dẫn tuyệt đối (ví dụ `/opt/homebrew/bin/node` với Node cài bằng Homebrew trên Mac Apple Silicon).

**Claude Desktop**: thêm vào `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), rồi khởi động lại Claude Desktop:

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

Trên Windows viết đường dẫn với `\\`, ví dụ `"F:\\Tools\\figma-console-mcp\\figma-console-mcp\\index.js"`.

---

## Cách dùng

1. Mở file Figma cần làm, chạy **Plugins** → **Development** → **figma-console-bridge**. Giữ plugin mở trong lúc làm việc.
2. Panel hiện **"Idle — chờ Claude gọi"** khi rảnh và **"⚡ Claude đang lấy data..."** trong lúc chạy lệnh. Idle là bình thường: plugin thử kết nối mỗi 500ms và chỉ vào được khi Claude đang gọi tool.
3. Làm việc với Claude như bình thường. Gọi `figma_status` để kiểm tra plugin có trả lời không.

### Tools

| Tool | Mô tả |
|------|-------|
| `figma_eval` | Chạy JavaScript trong plugin context. Tham số `code` (bắt buộc) và `timeout` tính bằng ms (mặc định 30000) |
| `figma_status` | Gửi một lệnh thử tới plugin; trả về tên file và trang đang mở, hoặc lý do không kết nối được |
| `figma_get_selection` | id, tên, type, vị trí và kích thước các node đang chọn |
| `figma_get_page` | Trang hiện tại: id, tên, số children và 20 children đầu tiên |

### Viết code cho `figma_eval`

- Code là thân của một async function: dùng được `await`, và **phải `return`** giá trị muốn lấy về. Không có `return` thì kết quả là `(undefined)`.
- Object được `JSON.stringify`, string được trả nguyên.
- Lỗi được throw ra sẽ thành kết quả lỗi kèm message.

```js
// Đổi màu tất cả text node trên trang, trả về số node đã đổi
const texts = figma.currentPage.findAll(n => n.type === 'TEXT')
texts.forEach(n => n.fills = [{ type: 'SOLID', color: { r: 0.1, g: 0.37, b: 0.64 } }])
return texts.length
```

```js
// Lấy tên tất cả node top-level
return figma.currentPage.children.map(n => n.name)
```

```js
// Sửa nội dung text: phải load font trước
const t = figma.currentPage.selection[0]
await figma.loadFontAsync(t.fontName)
t.characters = 'Play'
return t.id
```

```js
// Tạo component từ node đang chọn
const sel = figma.currentPage.selection[0]
return figma.createComponentFromNode(sel).id
```

---

## Lưu ý

- **Bảo mật:** port chỉ mở trên `127.0.0.1` và chỉ nhận kết nối có origin `null` (iframe của plugin) hoặc không có origin. Máy khác trong LAN và trang web bình thường không kết nối được.
- **Tool khác dùng chung port 9988** cũng nên bind `127.0.0.1`, không bind `0.0.0.0` hay `::`. Bind wildcard vẫn thành công song song với `127.0.0.1:9988`, nên không bên nào biết port đang bận.
- Mở plugin ở nhiều file Figma: lệnh chạy ở plugin kết nối vào trước.
- Hết `timeout` thì tool báo lỗi, nhưng code đang chạy trong Figma không bị huỷ.
- Các lệnh gửi qua cùng một server chạy lần lượt, không song song.

## Xử lý sự cố

| Thông báo | Nguyên nhân và cách xử lý |
|-----------|---------------------------|
| `Figma plugin chưa chạy...` | Plugin chưa mở, hoặc đang kết nối vào một server khác trên cùng port. Chạy lại plugin. |
| `Port 9988 vẫn bận sau ...ms` | Một process khác giữ port quá lâu: thường là server bản cũ (giữ port suốt, từ trước khi đổi sang mở port theo từng lệnh) hoặc một script khác. Tìm process bằng `lsof -nP -iTCP:9988 -sTCP:LISTEN` (macOS) hoặc `netstat -ano \| findstr :9988` (Windows). Server bản cũ thì reconnect MCP ở session đó hoặc dừng process. |
| `Timeout sau ...ms` | Code chạy lâu hơn `timeout`. Tăng `timeout` hoặc chia nhỏ lệnh. |

---

## Nguồn gốc

Ý tưởng plugin bridge không dùng REST API lấy từ [vkhanhqui/figma-mcp-go](https://github.com/vkhanhqui/figma-mcp-go).

## License

MIT — xem [LICENSE](LICENSE).
