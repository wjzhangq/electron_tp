# hello 示例插件

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/plugins/hello/greet?name=Tom` | 返回 `{ message }`；缺少 `name` 时返回 3006 |
| POST | `/api/plugins/hello/echo` | 请求体 `{ "text": string }`，返回 `{ text, length }` |
| GET (SSE) | `/api/plugins/hello/count?n=5` | 每 500ms 推送 `progress` 事件 `{ i, total }`，结束时推送 `complete` |

## 自定义错误码

| code | 含义 |
|------|------|
| 40001 | `echo` 的 `text` 不是字符串 |
