# Codex & DeepSeek Scriptable Widgets

一组可在 iPhone 上直接运行的 Scriptable 小组件：Codex Widget 查询额度窗口，DeepSeek Widget 使用官方 API Key 查询账户余额。认证信息保存在 iOS Keychain，成功数据缓存在手机本地，支持离线显示。

## 项目结构

```text
provider/
  codex.js       # 读取认证、请求额度、解析 token_count、输出 JSON
scriptable/
  widget.js               # Codex 小/中号 Widget
  deepseek-widget.js      # DeepSeek 官方 API 余额 Widget
data/
  usage.json     # 标准 JSON 示例，也是 provider 默认输出
```

## DeepSeek 余额 Widget

DeepSeek Widget 不依赖电脑、provider 或远程 JSON，只从 iPhone 直接请求官方 `GET https://api.deepseek.com/user/balance` 接口。

1. 在 Scriptable 新建脚本，将 `scriptable/deepseek-widget.js` 完整复制进去。
2. 在 Scriptable App 内运行脚本，选择“输入 API Key”。没有 Key 时可选择“打开密钥页面”，登录 DeepSeek 开放平台并创建。
3. 粘贴 Key 并选择“验证并登录”。验证成功后，Key 会保存到 iOS Keychain。
4. 在主屏幕添加 Scriptable 小组件并选择该脚本；支持小号和中号布局。

再次在 Scriptable App 内运行脚本，可以刷新预览、更换 API Key、管理密钥、查看账单或退出登录。退出时会同时删除 Keychain 认证和手机余额缓存。中号 Widget 可点击状态标签运行脚本刷新，其他区域不设置跳转。

Widget 展示官方接口提供的总余额、充值余额、未过期赠送余额、结算币种和账户是否可调用；余额圆环以 100 元为 100%。DeepSeek 没有提供查询历史消耗的公开 API；官方文档要求在 Usage 页面按月份导出 CSV，因此组件不会推算或伪造历史消耗。

> 不要把 API Key 写进脚本或提交到 Git。Scriptable 的登录框使用安全文本输入，并且只有在官方余额接口验证成功后才会保存 Key。

## Codex 用量 Widget

### 1. 推荐：直接在 iPhone 使用

1. 在电脑上打开 `~/.codex/auth.json`，通过安全方式把完整 JSON 复制到 iPhone 剪贴板。
2. 在 Scriptable 新建脚本，将 `scriptable/widget.js` 完整复制进去。
3. 在 Scriptable App 内运行一次脚本，选择“从剪贴板导入”。脚本只把认证字段保存到 iOS Keychain，并立即清空剪贴板。
4. 在 iOS 主屏幕添加 Scriptable 小组件，选择该脚本；小号和中号会自动使用对应布局。

脚本默认每 15 分钟在线刷新，并把最后一次成功数据写入 Scriptable 的 iCloud Documents `usage.json`。请求失败时会显示缓存和“离线”状态。需要重新导入登录信息时，把脚本顶部的 `setupOnNextRun` 临时改为 `true`，在 App 内运行一次后再改回 `false`。

中号 Codex 与 DeepSeek Widget 的状态标签可单独点击刷新。Scriptable 的小号 Widget 只支持整个组件一个点击目标，因此小号不提供状态标签点击，继续使用定时刷新。

> 不要把 access token 或 refresh token 直接写进脚本，也不要提交到 Git。Keychain 导入可以避免认证信息跟随脚本源码同步或分享。

### 2. 可选：通过电脑生成 usage.json

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

### 3. 把 provider 数据同步到 Scriptable

推荐把 provider 输出直接指向 Scriptable 的 iCloud Documents 中，文件名保持 `usage.json`。macOS 上的常见路径如下；实际路径以本机 iCloud Drive 为准：

```bash
node provider/codex.js --output "$HOME/Library/Mobile Documents/iCloud~dk~simonbs~Scriptable/Documents/usage.json"
```

也可以把 `usage.json` 放在一个可通过 HTTPS 读取的位置。在 iOS 添加 Scriptable Widget 后，将该 JSON URL 填入 Widget Parameter。远程请求成功时，Widget 会把数据缓存到 iCloud；请求失败时自动显示上一次成功数据。

> `usage.json` 不包含 access token、refresh token 或 account id，但包含账户套餐和用量信息。若使用远程 URL，仍建议限制访问权限。

### 4. 使用远程 JSON

如不使用手机直连，可将脚本顶部的 `directMode` 改为 `false`，然后在 Widget Parameter 填入标准 JSON 的 HTTPS URL。远程请求成功时会更新 iCloud 缓存，失败时显示最后一次成功数据。

Widget 每 15 分钟请求一次刷新。数据超过 45 分钟、provider 标记离线，或远程请求失败时，会显示“离线”状态。

### JSON 字段

`data/usage.json` 是完整示例，初始状态明确标记为 `source: "sample"` 与离线，运行 provider 后会被真实数据覆盖。核心字段如下：

- `limits.fiveHour`：短时窗口；服务端未返回时为 `null`。
- `limits.week`：周窗口；服务端未返回时为 `null`。
- `tokens.consumed`：最新 Codex session 的累计 token 消耗。
- `tokens.remaining`：`model_context_window - last_token_usage.total_tokens`，表示当前上下文估算剩余，不是账户套餐的 token 余额。
- `resetCredits.availableCount`：当前可用的使用限制重置次数；接口未返回时为 `null`。
- `updatedAt`：最近一次成功获取额度的时间。
- `offline`、`source`、`error`：缓存与错误状态。

Codex 的 usage 响应提供额度百分比、重置时间和可用重置次数，但不提供套餐 token 总额。因此 Widget 展示“周已用”和“重置额度”；provider 仍会从 `~/.codex/sessions` 最新的 `token_count` 事件读取当前 session 统计并保留在标准 JSON 中。

当前官方 Codex 客户端把 primary 与 secondary 两个窗口都定义为可选。组件会根据 `limit_window_seconds` 识别窗口：只返回周额度时仅显示周环；同时返回短时和周额度时显示双环。

### 缓存策略

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
- [DeepSeek 查询余额](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)：官方余额字段和 Bearer API Key 认证。
- [DeepSeek FAQ](https://api-docs.deepseek.com/faq)：历史用量按 API Key 导出方式。

Codex 个人用量没有公开、稳定的 REST API 文档。本项目使用官方 Codex 客户端当前调用的 ChatGPT 登录态路径，属于内部接口，服务端调整后可能需要同步更新。
