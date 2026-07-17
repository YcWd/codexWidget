// DeepSeek Balance · Scriptable Widget
// 首次在 Scriptable App 内运行，通过官方 API Key 登录。

const SETTINGS = {
  keychainKey: "deepseekWidget.apiKey.v1",
  cacheFile: "deepseek-balance-cache.json",
  balanceURL: "https://api.deepseek.com/user/balance",
  apiKeyPage: "https://platform.deepseek.com/api_keys",
  billingPage: "https://platform.deepseek.com/transactions",
  balanceTarget: 100,
  requestTimeout: 12,
  refreshMinutes: 15,
};

const PALETTE = {
  white: new Color("#F7FAFF"),
  muted: new Color("#A8B4C8"),
  dim: new Color("#6F7D94"),
  blue: new Color("#4D8DFF"),
  cyan: new Color("#35D7E7"),
  green: new Color("#5EE6A8"),
  orange: new Color("#FFB340"),
  red: new Color("#FF5C78"),
  track: new Color("#343941"),
  card: new Color("#FFFFFF", 0.075),
  cardBorder: new Color("#FFFFFF", 0.12),
};

/** 返回手机本地缓存文件路径。 */
function cachePath() {
  const manager = FileManager.local();
  return manager.joinPath(manager.documentsDirectory(), SETTINGS.cacheFile);
}

/** 读取最后一次成功的账户余额。 */
function readCache() {
  const manager = FileManager.local();
  const filePath = cachePath();
  if (!manager.fileExists(filePath)) return null;
  return JSON.parse(manager.readString(filePath));
}

/** 保存账户余额供离线显示。 */
function saveCache(data) {
  FileManager.local().writeString(cachePath(), JSON.stringify(data, null, 2));
}

/** 删除退出账号后的旧余额缓存。 */
function clearCache() {
  const manager = FileManager.local();
  const filePath = cachePath();
  if (manager.fileExists(filePath)) manager.remove(filePath);
}

function readApiKey() {
  if (!Keychain.contains(SETTINGS.keychainKey)) return null;
  const value = Keychain.get(SETTINGS.keychainKey).trim();
  return value || null;
}

function saveApiKey(apiKey) {
  Keychain.set(SETTINGS.keychainKey, apiKey);
}

function deleteApiKey() {
  if (Keychain.contains(SETTINGS.keychainKey)) Keychain.remove(SETTINGS.keychainKey);
}

/** 调用 DeepSeek 官方余额接口。 */
async function requestBalance(apiKey) {
  const request = new Request(SETTINGS.balanceURL);
  request.method = "GET";
  request.timeoutInterval = SETTINGS.requestTimeout;
  request.headers = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const responseText = await request.loadString();
  const status = request.response ? request.response.statusCode : 0;
  let body;
  try {
    body = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`DeepSeek 返回了非 JSON 内容（HTTP ${status || "--"}）`);
  }
  if (status < 200 || status >= 300) {
    const apiMessage = body && (body.message || body.error && body.error.message);
    throw new Error(apiMessage || `DeepSeek API 请求失败（HTTP ${status || "--"}）`);
  }
  return body;
}

/** 将官方余额响应转换为稳定的缓存结构。 */
function normalizeBalance(response) {
  const balanceInfos = Array.isArray(response.balance_infos) ? response.balance_infos : [];
  if (balanceInfos.length === 0) throw new Error("DeepSeek API 没有返回余额信息");
  const balance = balanceInfos.find((item) => item.currency === "CNY") || balanceInfos[0];
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    source: "deepseek-api",
    updatedAt: now,
    checkedAt: now,
    available: Boolean(response.is_available),
    balance: {
      currency: String(balance.currency),
      total: String(balance.total_balance),
      granted: String(balance.granted_balance),
      toppedUp: String(balance.topped_up_balance),
    },
  };
}

function isValidData(data) {
  return Boolean(data && data.schemaVersion === 1 && data.balance && data.balance.currency);
}

/** 在线加载余额，失败时回退手机缓存。 */
async function loadBalance(apiKey) {
  try {
    const data = normalizeBalance(await requestBalance(apiKey));
    saveCache(data);
    return { data, offline: false };
  } catch (error) {
    let cached = null;
    try {
      cached = readCache();
    } catch (cacheError) {
      console.warn(`忽略无效缓存: ${cacheError.message || cacheError}`);
    }
    if (!isValidData(cached)) throw error;
    return { data: cached, offline: true };
  }
}

/** 显示简单的操作结果提示。 */
async function showMessage(title, message) {
  const alert = new Alert();
  alert.title = title;
  alert.message = message;
  alert.addAction("好");
  await alert.presentAlert();
}

/** 输入并验证 API Key，验证成功后保存到 iOS Keychain。 */
async function inputApiKey() {
  const input = new Alert();
  input.title = "登录 DeepSeek";
  input.message = "粘贴 DeepSeek 开放平台 API Key。Key 会先通过官方余额接口验证，再保存到 iOS Keychain。";
  input.addSecureTextField("sk-...", "");
  input.addAction("验证并登录");
  input.addCancelAction("取消");
  if (await input.presentAlert() !== 0) return null;

  const apiKey = input.textFieldValue(0).trim();
  if (!apiKey) {
    await showMessage("登录失败", "API Key 不能为空");
    return null;
  }

  try {
    const data = normalizeBalance(await requestBalance(apiKey));
    saveApiKey(apiKey);
    saveCache(data);
    await showMessage("登录成功", `当前总余额 ${formatMoney(data.balance.total, data.balance.currency)}`);
    return apiKey;
  } catch (error) {
    await showMessage("验证失败", error.message || String(error));
    return null;
  }
}

/** 引导未登录用户输入 Key 或打开官方密钥页面。 */
async function presentLoginGuide() {
  const alert = new Alert();
  alert.title = "登录 DeepSeek";
  alert.message = "DeepSeek 官方 API 使用 API Key 认证。没有 Key 时，可先打开官方平台登录账号并创建。";
  alert.addAction("输入 API Key");
  alert.addAction("打开密钥页面");
  alert.addCancelAction("取消");
  const action = await alert.presentAlert();
  if (action === 0) return inputApiKey();
  if (action === 1) {
    await Safari.openInApp(SETTINGS.apiKeyPage, false);
    return inputApiKey();
  }
  return null;
}

/** 为已登录用户提供刷新、切换、管理和退出操作。 */
async function presentAccountMenu(apiKey) {
  const alert = new Alert();
  alert.title = "DeepSeek 账户";
  alert.message = "API Key 已安全保存在 iOS Keychain。";
  alert.addAction("刷新并预览");
  alert.addAction("更换 API Key");
  alert.addAction("管理 API Key");
  alert.addAction("查看账单");
  alert.addDestructiveAction("退出登录");
  alert.addCancelAction("取消");
  const action = await alert.presentAlert();
  if (action === 0) return apiKey;
  if (action === 1) return await inputApiKey();
  if (action === 2) {
    await Safari.openInApp(SETTINGS.apiKeyPage, false);
    return apiKey;
  }
  if (action === 3) {
    await Safari.openInApp(SETTINGS.billingPage, false);
    return apiKey;
  }
  if (action === 4) {
    deleteApiKey();
    clearCache();
    await showMessage("已退出登录", "API Key 和本机余额缓存已删除");
  }
  return null;
}

function currencySymbol(currency) {
  if (currency === "CNY") return "¥";
  if (currency === "USD") return "$";
  return `${currency} `;
}

function formatMoney(value, currency) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${currencySymbol(currency)}${number.toFixed(2)}`;
}

function formatUpdatedAt(value) {
  if (!value) return "--:--";
  const formatter = new DateFormatter();
  formatter.dateFormat = "HH:mm";
  return formatter.string(new Date(value));
}

function addText(stack, value, font, color, lineLimit) {
  const text = stack.addText(String(value));
  text.font = font;
  text.textColor = color;
  text.lineLimit = lineLimit == null ? 1 : lineLimit;
  text.minimumScaleFactor = 0.65;
  return text;
}

function rgbToHex(rgb) {
  return rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("");
}

function mixColor(start, end, amount) {
  return new Color(rgbToHex(start.map((value, index) => value + (end[index] - value) * amount)));
}

/** 按 100 元满额计算余额圆环百分比。 */
function balancePercent(total) {
  const amount = Number(total);
  if (!Number.isFinite(amount)) return 0;
  return Math.min(100, Math.max(0, amount / SETTINGS.balanceTarget * 100));
}

/** 按余额百分比绘制 DeepSeek 渐变圆环。 */
function balanceRingImage(size, percent, available) {
  const context = new DrawContext();
  context.size = new Size(size, size);
  context.opaque = false;
  context.respectScreenScale = true;
  const center = size / 2;
  const radius = size * 0.36;
  const width = size * 0.105;
  const segments = 150;
  const activeSegments = Math.round(segments * percent / 100);

  context.setFillColor(PALETTE.track);
  for (let index = 0; index < segments; index += 1) {
    const angle = -Math.PI / 2 + index / segments * Math.PI * 2;
    context.fillEllipse(new Rect(
      center + Math.cos(angle) * radius - width / 2,
      center + Math.sin(angle) * radius - width / 2,
      width,
      width,
    ));
  }

  for (let index = 0; index < activeSegments; index += 1) {
    const amount = activeSegments <= 1 ? 0 : index / (activeSegments - 1);
    const angle = -Math.PI / 2 + index / segments * Math.PI * 2;
    context.setFillColor(available
      ? mixColor([77, 141, 255], [53, 215, 231], amount)
      : PALETTE.red);
    context.fillEllipse(new Rect(
      center + Math.cos(angle) * radius - width / 2,
      center + Math.sin(angle) * radius - width / 2,
      width,
      width,
    ));
  }
  return context.getImage();
}

/** 创建余额圆环和居中金额。 */
function addBalanceRing(parent, size, data) {
  const ring = parent.addStack();
  ring.size = new Size(size, size);
  ring.backgroundImage = balanceRingImage(size, balancePercent(data.balance.total), data.available);
  ring.layoutVertically();
  ring.addSpacer();

  const valueRow = ring.addStack();
  valueRow.layoutHorizontally();
  valueRow.addSpacer();
  addText(
    valueRow,
    formatMoney(data.balance.total, data.balance.currency),
    Font.boldSystemFont(size * 0.145),
    PALETTE.white,
  );
  valueRow.addSpacer();

  const labelRow = ring.addStack();
  labelRow.layoutHorizontally();
  labelRow.addSpacer();
  addText(labelRow, "可用余额", Font.semiboldSystemFont(size * 0.07), PALETTE.muted);
  labelRow.addSpacer();
  ring.addSpacer();
  return ring;
}

function configureBackground(widget) {
  const gradient = new LinearGradient();
  gradient.colors = [new Color("#060A13"), new Color("#101A30"), new Color("#072029")];
  gradient.locations = [0, 0.58, 1];
  gradient.startPoint = new Point(0, 0);
  gradient.endPoint = new Point(1, 1);
  widget.backgroundGradient = gradient;
}

function addStatusBadge(parent, data, offline) {
  const available = data && data.available;
  const badge = parent.addStack();
  badge.setPadding(3, 7, 3, 7);
  badge.cornerRadius = 8;
  const color = offline ? PALETTE.orange : available ? PALETTE.green : PALETTE.red;
  badge.backgroundColor = offline
    ? new Color("#FFB340", 0.14)
    : available ? new Color("#5EE6A8", 0.14) : new Color("#FF5C78", 0.14);
  addText(badge, offline ? "离线" : available ? "可用" : "余额不足", Font.semiboldSystemFont(8), color);
}

function addHeader(widget, data, offline, compact) {
  const header = widget.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();
  addText(header, "DEEPSEEK", Font.boldSystemFont(compact ? 11 : 13), PALETTE.white);
  header.addSpacer(6);
  addText(header, "API", Font.mediumSystemFont(8), PALETTE.dim);
  header.addSpacer();
  addStatusBadge(header, data, offline);
  header.addSpacer(6);
  addText(header, formatUpdatedAt(data.updatedAt), Font.mediumSystemFont(8), PALETTE.muted);
}

function addMetricCard(parent, label, value, color, compact) {
  const card = parent.addStack();
  card.layoutVertically();
  if (!compact) card.size = new Size(84, 56);
  card.setPadding(compact ? 5 : 8, compact ? 7 : 10, compact ? 5 : 7, compact ? 7 : 10);
  card.cornerRadius = compact ? 11 : 13;
  card.backgroundColor = PALETTE.card;
  card.borderColor = PALETTE.cardBorder;
  card.borderWidth = 0.5;
  addText(card, label, Font.mediumSystemFont(compact ? 7 : 9), PALETTE.muted);
  card.addSpacer(2);
  addText(card, value, Font.boldSystemFont(compact ? 11 : 16), color);
  return card;
}

function addInfoRow(parent, label, value, color) {
  const row = parent.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  addText(row, label, Font.mediumSystemFont(9), PALETTE.muted);
  row.addSpacer();
  addText(row, value, Font.semiboldSystemFont(10), color || PALETTE.white);
}

/** 构建 DeepSeek 小号余额 Widget。 */
function buildSmallWidget(data, offline) {
  const widget = new ListWidget();
  widget.setPadding(10, 11, 9, 11);
  configureBackground(widget);
  addHeader(widget, data, offline, true);
  widget.addSpacer(3);

  const ringRow = widget.addStack();
  ringRow.addSpacer();
  addBalanceRing(ringRow, 84, data);
  ringRow.addSpacer();

  widget.addSpacer(3);
  const metrics = widget.addStack();
  metrics.layoutHorizontally();
  addMetricCard(
    metrics,
    "充值",
    formatMoney(data.balance.toppedUp, data.balance.currency),
    PALETTE.white,
    true,
  );
  metrics.addSpacer(5);
  addMetricCard(
    metrics,
    "赠送",
    formatMoney(data.balance.granted, data.balance.currency),
    PALETTE.cyan,
    true,
  );
  return widget;
}

/** 构建 DeepSeek 中号余额 Widget。 */
function buildMediumWidget(data, offline) {
  const widget = new ListWidget();
  widget.setPadding(13, 15, 12, 15);
  configureBackground(widget);
  addHeader(widget, data, offline, false);
  widget.addSpacer(9);

  const content = widget.addStack();
  content.layoutHorizontally();
  const left = content.addStack();
  left.layoutVertically();
  addBalanceRing(left, 108, data);

  content.addSpacer(15);
  const right = content.addStack();
  right.layoutVertically();
  const metrics = right.addStack();
  metrics.layoutHorizontally();
  addMetricCard(
    metrics,
    "充值余额",
    formatMoney(data.balance.toppedUp, data.balance.currency),
    PALETTE.white,
    false,
  );
  metrics.addSpacer(6);
  addMetricCard(
    metrics,
    "赠送余额",
    formatMoney(data.balance.granted, data.balance.currency),
    PALETTE.cyan,
    false,
  );

  right.addSpacer(9);
  addInfoRow(right, "账户状态", data.available ? "API 可调用" : "余额不足", data.available ? PALETTE.green : PALETTE.red);
  right.addSpacer(6);
  addInfoRow(right, "结算币种", data.balance.currency, PALETTE.blue);
  return widget;
}

function buildLoginWidget(message) {
  const widget = new ListWidget();
  widget.setPadding(16, 16, 16, 16);
  configureBackground(widget);
  addText(widget, "DEEPSEEK", Font.boldSystemFont(13), PALETTE.white);
  widget.addSpacer();
  addText(widget, "尚未登录", Font.boldSystemFont(17), PALETTE.white);
  widget.addSpacer(5);
  addText(widget, message, Font.systemFont(10), PALETTE.muted, 3);
  widget.addSpacer();
  addText(widget, "请在 Scriptable App 内运行脚本", Font.mediumSystemFont(9), PALETTE.cyan);
  return widget;
}

function buildErrorWidget(message) {
  const widget = new ListWidget();
  widget.setPadding(16, 16, 16, 16);
  configureBackground(widget);
  addText(widget, "DEEPSEEK", Font.boldSystemFont(13), PALETTE.white);
  widget.addSpacer();
  addText(widget, "余额获取失败", Font.boldSystemFont(17), PALETTE.white);
  widget.addSpacer(5);
  addText(widget, message, Font.systemFont(10), PALETTE.muted, 3);
  widget.addSpacer();
  addText(widget, "在 App 内运行可更换 API Key", Font.mediumSystemFont(9), PALETTE.orange);
  return widget;
}

/** 管理登录状态、加载数据并渲染对应尺寸。 */
async function main() {
  const previewFamily = args.queryParameters && args.queryParameters.family;
  const family = config.widgetFamily || previewFamily || "medium";
  let apiKey = readApiKey();

  if (config.runsInApp) {
    apiKey = apiKey ? await presentAccountMenu(apiKey) : await presentLoginGuide();
    if (!apiKey) {
      Script.complete();
      return;
    }
  }

  let widget;
  if (!apiKey) {
    widget = buildLoginWidget("使用 DeepSeek 官方 API Key 登录后即可直接查询账户余额。");
  } else {
    try {
      const result = await loadBalance(apiKey);
      widget = family === "small"
        ? buildSmallWidget(result.data, result.offline)
        : buildMediumWidget(result.data, result.offline);
    } catch (error) {
      widget = buildErrorWidget(error.message || String(error));
    }
  }

  widget.url = URLScheme.forRunningScript();
  widget.refreshAfterDate = new Date(Date.now() + SETTINGS.refreshMinutes * 60 * 1000);
  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else if (family === "small") {
    await widget.presentSmall();
  } else {
    await widget.presentMedium();
  }
  Script.complete();
}

await main();
