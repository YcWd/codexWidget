# Codex Usage Scriptable Widget

一个由本机 provider 和 iOS Scriptable Widget 组成的 Codex 用量组件。provider 优先读取 `~/.codex/auth.json`，合并 Codex 额度与最新 session 的 token 信息，输出稳定 JSON；Widget 用 Apple Fitness 风格双圆环显示数据，并支持缓存和离线状态。

## 项目结构

```text
provider/
  codex.js       # 读取认证、请求额度、解析 token_count、输出 JSON
scriptable/
  widget.js      # Scriptable 小/中号 Widget
data/
  usage.json     # 标准 JSON 示例，也是 provider 默认输出
```

## 1. 生成 usage.json

要求 Node.js 18 或更高版本，并已通过 Codex CLI / Codex App 登录。

```bash
node provider/codex.js
```

命令会把单行标准 JSON 输出到 stdout，同时原子写入 `data/usage.json`。可指定其他位置：

```bash
node provider/codex.js --output /path/to/usage.json
node provider/codex.js --auth /path/to/auth.json --output /path/to/usage.json
node provider/codex.js --no-refresh
```

环境变量也可配置：

- `CODEX_AUTH_PATH`：认证文件位置。
- `CODEX_USAGE_OUTPUT`：JSON 输出位置。
- `CODEX_USAGE_URLS`：用分号分隔的 usage 地址。
- `CODEX_USAGE_TOKEN_URL`、`CODEX_USAGE_CLIENT_ID`：token 刷新配置。

当接口返回 401 时，provider 默认使用 `refresh_token` 刷新并原子写回原认证文件。使用 `--no-refresh` 可关闭写回。

## 2. 把数据同步到 Scriptable

推荐把 provider 输出直接指向 Scriptable 的 iCloud Documents 中，文件名保持 `usage.json`。macOS 上的常见路径如下；实际路径以本机 iCloud Drive 为准：

```bash
node provider/codex.js --output "$HOME/Library/Mobile Documents/iCloud~dk~simonbs~Scriptable/Documents/usage.json"
```

也可以把 `usage.json` 放在一个可通过 HTTPS 读取的位置。在 iOS 添加 Scriptable Widget 后，将该 JSON URL 填入 Widget Parameter。远程请求成功时，Widget 会把数据缓存到 iCloud；请求失败时自动显示上一次成功数据。

> `usage.json` 不包含 access token、refresh token 或 account id，但包含账户套餐和用量信息。若使用远程 URL，仍建议限制访问权限。

## 3. 安装 Widget

1. 在 Scriptable 新建脚本，将 `scriptable/widget.js` 完整复制进去。
2. 确认 Scriptable iCloud Documents 根目录中已有 `usage.json`，或在 Widget Parameter 中填写 JSON URL。
3. 在 iOS 主屏幕添加 Scriptable 小组件，选择该脚本。
4. 小号和中号尺寸会自动使用各自布局；在 Scriptable App 内直接运行默认预览中号。

Widget 每 15 分钟请求一次刷新。数据超过 45 分钟、provider 标记离线，或远程请求失败时，会显示“离线”状态。

## JSON 字段

`data/usage.json` 是完整示例。核心字段如下：

- `limits.fiveHour`：5 小时窗口的已用/剩余百分比和重置时间。
- `limits.week`：周窗口的已用/剩余百分比和重置时间。
- `tokens.consumed`：最新 Codex session 的累计 token 消耗。
- `tokens.remaining`：`model_context_window - last_token_usage.total_tokens`，表示当前上下文估算剩余，不是账户套餐的 token 余额。
- `updatedAt`：最近一次成功获取额度的时间。
- `offline`、`source`、`error`：缓存与错误状态。

Codex 的 usage 接口本身只返回额度百分比和重置时间，不返回套餐 token 总额。因此 Widget 不会用额度百分比伪造 token 数；token 字段来自 `~/.codex/sessions` 中最新的 `token_count` 事件。若本机还没有 session 日志，token 字段会是 `null`，UI 显示 `--`。

## 缓存策略

- provider 请求成功后覆盖输出 JSON。
- provider 请求失败且已有输出时，保留上次数据并标记 `offline: true`、`source: "cache"`。
- Scriptable 远程请求成功后写入 iCloud `usage.json`；失败时回退该文件。
- 没有任何有效数据时，Widget 显示配置提示，不生成虚假额度。

## 验证

以下命令只做语法检查和本地单元测试，不会请求网络：

```bash
npm run check
npm test
```

## 参考

- [cczvil/codex-usage-widget](https://github.com/cczvil/codex-usage-widget)：Codex usage 请求与 Scriptable 数据展示思路。
- [WeikangLin93/codex-usage-widget](https://github.com/WeikangLin93/codex-usage-widget)：`auth.json`、JWT account id、token 刷新与离线缓存逻辑。
- [Scriptable Widget API](https://docs.scriptable.app/listwidget/)：`ListWidget`、`DrawContext`、`FileManager` 与 `Request`。

Codex usage 地址属于社区使用的非官方接口，服务端调整后可能需要同步更新 provider。
