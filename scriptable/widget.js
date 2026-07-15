// Codex Usage · Scriptable Widget
// 首次在 Scriptable App 内运行，从剪贴板导入 ~/.codex/auth.json。

const SETTINGS = {
  directMode: true,
  setupOnNextRun: false,
  dataURL: "",
  localFile: "usage.json",
  requestTimeout: 12,
  refreshMinutes: 15,
  staleMinutes: 45,
};

const CODEX_AUTH = {
  keychainKey: "codexUsage.auth.v1",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  tokenURL: "https://auth.openai.com/oauth/token",
  usageURLs: [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/codex/usage",
  ],
};

const PALETTE = {
  white: new Color("#F7FAFF"),
  muted: new Color("#A8B1C2"),
  dim: new Color("#747F92"),
  magenta: new Color("#FF375F"),
  orange: new Color("#FF9F0A"),
  lime: new Color("#B7F700"),
  cyan: new Color("#30D8C8"),
  card: new Color("#FFFFFF", 0.075),
  cardBorder: new Color("#FFFFFF", 0.12),
};

/** 读取 iCloud Documents 中的 usage.json。 */
async function readLocalUsage() {
  const manager = FileManager.iCloud();
  const filePath = manager.joinPath(manager.documentsDirectory(), SETTINGS.localFile);
  if (!manager.fileExists(filePath)) return null;
  await manager.downloadFileFromiCloud(filePath);
  return JSON.parse(manager.readString(filePath));
}

/** 将远程成功数据保存到 iCloud，供离线回退。 */
async function saveLocalUsage(data) {
  const manager = FileManager.iCloud();
  const filePath = manager.joinPath(manager.documentsDirectory(), SETTINGS.localFile);
  manager.writeString(filePath, JSON.stringify(data, null, 2));
}

function isValidUsage(data) {
  return Boolean(
    data &&
    data.schemaVersion === 1 &&
    data.limits &&
    (data.limits.fiveHour || data.limits.week)
  );
}

/** 解码 JWT payload，用于从 id_token 提取 account id。 */
function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const segments = token.split(".");
  if (segments.length < 2) return null;

  try {
    let base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    const data = Data.fromBase64String(base64);
    return data ? JSON.parse(data.toRawString()) : null;
  } catch (error) {
    return null;
  }
}

function accountIdFromTokens(tokens) {
  if (tokens.account_id || tokens.accountId) return tokens.account_id || tokens.accountId;
  const payloads = [decodeJwtPayload(tokens.id_token), decodeJwtPayload(tokens.access_token || tokens.accessToken)];
  for (const payload of payloads) {
    const authClaim = payload && payload["https://api.openai.com/auth"];
    if (authClaim && authClaim.chatgpt_account_id) return authClaim.chatgpt_account_id;
  }
  return null;
}

/** 将完整 auth.json 或导出对象转换为最小认证结构。 */
function parseImportedAuth(value) {
  const source = value.codex || value.tokens || value;
  const accessToken = source.access_token || source.accessToken;
  if (!accessToken) throw new Error("未找到 access_token");
  return {
    accessToken,
    refreshToken: source.refresh_token || source.refreshToken || null,
    accountId: accountIdFromTokens(source),
    updatedAt: new Date().toISOString(),
  };
}

function readStoredAuth() {
  if (!Keychain.contains(CODEX_AUTH.keychainKey)) return null;
  try {
    return parseImportedAuth(JSON.parse(Keychain.get(CODEX_AUTH.keychainKey)));
  } catch (error) {
    return null;
  }
}

function saveStoredAuth(auth) {
  Keychain.set(CODEX_AUTH.keychainKey, JSON.stringify(auth));
}

/** 在 App 内从剪贴板导入 auth.json，并保存到 iOS Keychain。 */
async function setupDirectAuth() {
  const alert = new Alert();
  alert.title = "配置 Codex 登录";
  alert.message = "先把 ~/.codex/auth.json 的完整 JSON 复制到手机剪贴板。导入后只保留 OAuth token，并存入 iOS Keychain。";
  alert.addAction("从剪贴板导入");
  alert.addCancelAction("取消");
  if (await alert.presentAlert() !== 0) return null;

  let auth;
  try {
    auth = parseImportedAuth(JSON.parse(Pasteboard.paste()));
  } catch (error) {
    const failed = new Alert();
    failed.title = "导入失败";
    failed.message = error.message || String(error);
    failed.addAction("好");
    await failed.presentAlert();
    return null;
  }

  saveStoredAuth(auth);
  Pasteboard.copy("");
  const success = new Alert();
  success.title = "导入成功";
  success.message = "认证信息已保存到 iOS Keychain，剪贴板中的 token 已清除。";
  success.addAction("继续");
  await success.presentAlert();
  return auth;
}

/** 执行 Scriptable JSON 请求，并保留 HTTP 状态。 */
async function requestJSON(url, options) {
  const request = new Request(url);
  request.timeoutInterval = SETTINGS.requestTimeout;
  request.method = options && options.method || "GET";
  request.headers = options && options.headers || { Accept: "application/json" };
  if (options && options.body) request.body = options.body;
  const responseText = await request.loadString();
  const status = request.response ? request.response.statusCode : 0;
  let body = null;
  try {
    body = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`接口返回非 JSON 内容（HTTP ${status || "--"}）`);
  }
  return { status, body };
}

function usageHeaders(auth) {
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/codex",
    "User-Agent": "codex-cli",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  return headers;
}

/** 请求 Codex usage；401 会交给上层刷新 token。 */
async function requestCodexUsage(auth) {
  let lastError = null;
  for (const url of CODEX_AUTH.usageURLs) {
    try {
      const response = await requestJSON(url, { headers: usageHeaders(auth) });
      if (response.status === 401) {
        const unauthorized = new Error("Codex 登录已过期");
        unauthorized.status = 401;
        throw unauthorized;
      }
      const rateLimit = response.body && response.body.rate_limit;
      const hasWindow = rateLimit && (rateLimit.primary_window || rateLimit.secondary_window);
      if (response.status < 200 || response.status >= 300 || !hasWindow) {
        throw new Error(`usage 请求失败（HTTP ${response.status || "--"}）`);
      }
      return response.body;
    } catch (error) {
      if (error.status === 401) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("Codex usage 请求失败");
}

/** 使用 refresh_token 更新 Keychain 中的认证信息。 */
async function refreshDirectAuth(auth) {
  if (!auth.refreshToken) throw new Error("缺少 refresh_token，请重新导入 auth.json");
  const body = [
    "grant_type=refresh_token",
    `refresh_token=${encodeURIComponent(auth.refreshToken)}`,
    `client_id=${encodeURIComponent(CODEX_AUTH.clientId)}`,
  ].join("&");
  const response = await requestJSON(CODEX_AUTH.tokenURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (response.status < 200 || response.status >= 300 || !response.body.access_token) {
    throw new Error("刷新 token 失败，请重新导入 auth.json");
  }

  const refreshedSource = {
    access_token: response.body.access_token,
    refresh_token: response.body.refresh_token || auth.refreshToken,
    id_token: response.body.id_token,
    account_id: auth.accountId,
  };
  const refreshed = parseImportedAuth(refreshedSource);
  saveStoredAuth(refreshed);
  return refreshed;
}

function normalizedPercent(value) {
  return Math.round(Math.min(100, Math.max(0, Number(value) || 0)) * 10) / 10;
}

function normalizeDirectWindow(window, now) {
  if (!window) return null;
  const usedPercent = normalizedPercent(window.used_percent);
  const resetAfterSeconds = Math.max(0, Number(window.reset_after_seconds) || 0);
  const resetAtSeconds = Number(window.reset_at) || (resetAfterSeconds ? now.getTime() / 1000 + resetAfterSeconds : 0);
  return {
    usedPercent,
    remainingPercent: Math.round((100 - usedPercent) * 10) / 10,
    windowSeconds: Math.max(0, Number(window.limit_window_seconds) || 0),
    resetAt: resetAtSeconds ? new Date(resetAtSeconds * 1000).toISOString() : null,
    resetInSeconds: resetAtSeconds ? Math.max(0, Math.round(resetAtSeconds - now.getTime() / 1000)) : 0,
  };
}

/** 按接口返回的窗口时长识别 5 小时与周额度。 */
function classifyDirectWindows(rateLimit) {
  const entries = [
    { position: "primary", value: rateLimit.primary_window || null },
    { position: "secondary", value: rateLimit.secondary_window || null },
  ].filter((entry) => entry.value);
  let fiveHour = null;
  let week = null;

  for (const entry of entries) {
    const seconds = Number(entry.value.limit_window_seconds) || 0;
    if (!week && seconds >= 5 * 24 * 60 * 60) {
      week = entry.value;
    } else if (!fiveHour && seconds > 0 && seconds <= 24 * 60 * 60) {
      fiveHour = entry.value;
    }
  }

  const unclassified = entries.filter((entry) => entry.value !== fiveHour && entry.value !== week);
  for (const entry of unclassified) {
    if (!week && entry.position === "secondary") week = entry.value;
    else if (!fiveHour) fiveHour = entry.value;
    else if (!week) week = entry.value;
  }
  return { fiveHour, week };
}

/** 将手机直连响应转换为与 provider 一致的标准 JSON。 */
function normalizeDirectUsage(usage) {
  const now = new Date();
  const windows = classifyDirectWindows(usage.rate_limit);
  return {
    schemaVersion: 1,
    ok: true,
    offline: false,
    source: "direct",
    updatedAt: now.toISOString(),
    checkedAt: now.toISOString(),
    account: { plan: String(usage.plan_type || usage.account_plan || "unknown") },
    limits: {
      fiveHour: normalizeDirectWindow(windows.fiveHour, now),
      week: normalizeDirectWindow(windows.week, now),
    },
    tokens: null,
    credits: usage.credits == null ? null : usage.credits,
    error: null,
  };
}

/** 使用 Keychain token 直接从手机获取用量。 */
async function fetchDirectUsage(auth) {
  let currentAuth = auth;
  let usage;
  try {
    usage = await requestCodexUsage(currentAuth);
  } catch (error) {
    if (error.status !== 401) throw error;
    currentAuth = await refreshDirectAuth(currentAuth);
    usage = await requestCodexUsage(currentAuth);
  }
  return normalizeDirectUsage(usage);
}

/** 加载手机直连、远程 JSON 或 iCloud 缓存数据。 */
async function loadUsage() {
  let cached = null;
  try {
    cached = await readLocalUsage();
  } catch (error) {
    console.warn(`忽略无效的本地缓存: ${error.message || error}`);
  }
  const parameter = typeof args.widgetParameter === "string" ? args.widgetParameter.trim() : "";
  const dataURL = parameter || SETTINGS.dataURL;
  let auth = SETTINGS.directMode ? readStoredAuth() : null;

  if (SETTINGS.directMode && config.runsInApp && (!auth || SETTINGS.setupOnNextRun)) {
    auth = await setupDirectAuth() || auth;
  }

  if (auth) {
    try {
      const direct = await fetchDirectUsage(auth);
      try {
        await saveLocalUsage(direct);
      } catch (error) {
        console.warn(`缓存手机直连数据失败: ${error.message || error}`);
      }
      return { data: direct, offline: false };
    } catch (error) {
      if (cached && isValidUsage(cached)) return { data: cached, offline: true };
      throw error;
    }
  }

  if (dataURL) {
    let data;
    try {
      const request = new Request(dataURL);
      request.timeoutInterval = SETTINGS.requestTimeout;
      request.headers = { Accept: "application/json" };
      const remote = JSON.parse(await request.loadString());
      if (!request.response || request.response.statusCode < 200 || request.response.statusCode >= 300) {
        throw new Error("usage 请求失败");
      }
      if (!isValidUsage(remote)) throw new Error("usage.json 格式无效");
      data = remote;
      try {
        await saveLocalUsage(remote);
      } catch (error) {
        console.warn(`缓存 usage.json 失败: ${error.message || error}`);
      }
    } catch (error) {
      if (!cached) throw error;
      return { data: cached, offline: true };
    }
    return { data, offline: Boolean(data.offline) };
  }

  if (!isValidUsage(cached)) {
    const message = SETTINGS.directMode
      ? "请先在 Scriptable App 内运行脚本，并从剪贴板导入 auth.json"
      : "未找到有效的 usage.json";
    throw new Error(message);
  }
  const updatedAt = cached.updatedAt ? new Date(cached.updatedAt).getTime() : 0;
  const ageMinutes = updatedAt ? (Date.now() - updatedAt) / 60000 : Infinity;
  return {
    data: cached,
    offline: Boolean(cached.offline || ageMinutes > SETTINGS.staleMinutes),
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function rgbToHex(rgb) {
  return rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("");
}

function mixColor(start, end, amount) {
  return new Color(rgbToHex(start.map((value, index) => value + (end[index] - value) * amount)));
}

/** 用重叠圆点绘制带圆角端点的 Fitness 风格进度环。 */
function drawRing(context, center, radius, width, percent, startColor, endColor) {
  const segments = 140;
  const trackColor = new Color("#FFFFFF", 0.095);
  const progressSegments = Math.round(segments * clamp(percent, 0, 100) / 100);

  context.setFillColor(trackColor);
  for (let index = 0; index < segments; index += 1) {
    const angle = -Math.PI / 2 + index / segments * Math.PI * 2;
    const x = center + Math.cos(angle) * radius - width / 2;
    const y = center + Math.sin(angle) * radius - width / 2;
    context.fillEllipse(new Rect(x, y, width, width));
  }

  for (let index = 0; index < progressSegments; index += 1) {
    const amount = progressSegments <= 1 ? 0 : index / (progressSegments - 1);
    const angle = -Math.PI / 2 + index / segments * Math.PI * 2;
    const x = center + Math.cos(angle) * radius - width / 2;
    const y = center + Math.sin(angle) * radius - width / 2;
    context.setFillColor(mixColor(startColor, endColor, amount));
    context.fillEllipse(new Rect(x, y, width, width));
  }
}

/** 根据服务端实际返回的额度窗口生成进度环。 */
function activityRingsImage(size, fiveHour, week) {
  const context = new DrawContext();
  context.size = new Size(size, size);
  context.opaque = false;
  context.respectScreenScale = true;
  const center = size / 2;

  if (fiveHour && week) {
    drawRing(context, center, size * 0.39, size * 0.095, fiveHour.remainingPercent, [255, 55, 95], [255, 159, 10]);
    drawRing(context, center, size * 0.265, size * 0.085, week.remainingPercent, [183, 247, 0], [48, 216, 200]);
  } else if (week) {
    drawRing(context, center, size * 0.37, size * 0.11, week.remainingPercent, [183, 247, 0], [48, 216, 200]);
  } else {
    drawRing(context, center, size * 0.37, size * 0.11, fiveHour.remainingPercent, [255, 55, 95], [255, 159, 10]);
  }
  return context.getImage();
}

function formatTokens(value) {
  if (value == null) return "--";
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(number));
}

function formatCountdown(resetAt) {
  if (!resetAt) return "--";
  const seconds = Math.max(0, Math.floor((new Date(resetAt).getTime() - Date.now()) / 1000));
  if (seconds === 0) return "即将重置";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  return `${Math.max(1, minutes)}分钟`;
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
  text.minimumScaleFactor = 0.7;
  return text;
}

function addStatusBadge(parent, offline) {
  const badge = parent.addStack();
  badge.setPadding(3, 7, 3, 7);
  badge.cornerRadius = 8;
  badge.backgroundColor = offline ? new Color("#FF9F0A", 0.16) : new Color("#30D8C8", 0.13);
  addText(
    badge,
    offline ? "离线" : "在线",
    Font.semiboldSystemFont(8),
    offline ? PALETTE.orange : PALETTE.cyan,
  );
}

function addLegendItem(parent, color, label, percent) {
  const item = parent.addStack();
  item.layoutHorizontally();
  item.centerAlignContent();
  addText(item, "●", Font.systemFont(7), color);
  item.addSpacer(3);
  addText(item, `${label} ${Math.round(percent)}%`, Font.semiboldSystemFont(9), PALETTE.white);
}

/** 在圆环 Stack 内创建水平居中的文字行。 */
function addCenteredRingText(parent, value, font, color) {
  const row = parent.addStack();
  row.layoutHorizontally();
  row.addSpacer();
  addText(row, value, font, color);
  row.addSpacer();
}

function addRingBlock(parent, size, fiveHour, week) {
  const mainWindow = fiveHour || week;
  const ring = parent.addStack();
  ring.size = new Size(size, size);
  ring.backgroundImage = activityRingsImage(size, fiveHour, week);
  ring.layoutVertically();
  ring.setPadding(size * 0.34, 0, 0, 0);
  addCenteredRingText(ring, `${Math.round(mainWindow.remainingPercent)}%`, Font.boldSystemFont(size * 0.18), PALETTE.white);
  addCenteredRingText(ring, fiveHour ? "5H 剩余" : "周剩余", Font.semiboldSystemFont(size * 0.075), PALETTE.muted);
  return ring;
}

function configureBackground(widget) {
  const gradient = new LinearGradient();
  gradient.colors = [new Color("#06070B"), new Color("#121825"), new Color("#071316")];
  gradient.locations = [0, 0.58, 1];
  gradient.startPoint = new Point(0, 0);
  gradient.endPoint = new Point(1, 1);
  widget.backgroundGradient = gradient;
}

function addHeader(widget, payload, offline, compact) {
  const header = widget.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();
  addText(header, "CODEX", Font.boldSystemFont(compact ? 11 : 13), PALETTE.white);
  header.addSpacer(6);
  addText(header, String(payload.account && payload.account.plan || "").toUpperCase(), Font.mediumSystemFont(8), PALETTE.dim);
  header.addSpacer();
  addStatusBadge(header, offline);
  header.addSpacer(6);
  addText(header, formatUpdatedAt(payload.updatedAt), Font.mediumSystemFont(8), PALETTE.muted);
}

/** 构建小号 Widget，按实际额度窗口压缩展示核心指标。 */
function buildSmallWidget(payload, offline) {
  const widget = new ListWidget();
  widget.setPadding(10, 11, 9, 11);
  configureBackground(widget);
  addHeader(widget, payload, offline, true);
  widget.addSpacer(3);

  const fiveHour = payload.limits.fiveHour;
  const week = payload.limits.week;
  const mainWindow = fiveHour || week;
  const ringRow = widget.addStack();
  ringRow.addSpacer();
  addRingBlock(ringRow, 74, fiveHour, week);
  ringRow.addSpacer();

  const legend = widget.addStack();
  legend.layoutHorizontally();
  legend.centerAlignContent();
  legend.addSpacer();
  if (fiveHour) addLegendItem(legend, PALETTE.magenta, "5H", fiveHour.remainingPercent);
  if (fiveHour && week) legend.addSpacer(8);
  if (week) addLegendItem(legend, PALETTE.lime, "周", week.remainingPercent);
  legend.addSpacer();

  widget.addSpacer(4);
  const tokens = widget.addStack();
  tokens.layoutHorizontally();
  addText(tokens, `消耗 ${formatTokens(payload.tokens && payload.tokens.consumed)}`, Font.semiboldSystemFont(9), PALETTE.white);
  tokens.addSpacer();
  addText(tokens, `剩余 ${formatTokens(payload.tokens && payload.tokens.remaining)}`, Font.semiboldSystemFont(9), PALETTE.cyan);

  widget.addSpacer(3);
  const footer = widget.addStack();
  footer.layoutHorizontally();
  addText(footer, `${fiveHour ? "5H" : "周"} 重置 ${formatCountdown(mainWindow.resetAt)}`, Font.mediumSystemFont(8), PALETTE.muted);
  footer.addSpacer();
  addText(footer, `更新 ${formatUpdatedAt(payload.updatedAt)}`, Font.mediumSystemFont(8), PALETTE.dim);
  return widget;
}

function addMetricCard(parent, label, value, color) {
  const card = parent.addStack();
  card.layoutVertically();
  card.setPadding(7, 8, 6, 8);
  card.cornerRadius = 11;
  card.backgroundColor = PALETTE.card;
  card.borderColor = PALETTE.cardBorder;
  card.borderWidth = 0.5;
  addText(card, label, Font.mediumSystemFont(8), PALETTE.muted);
  card.addSpacer(2);
  addText(card, value, Font.boldSystemFont(15), color);
  return card;
}

function addResetRow(parent, color, label, resetAt) {
  const row = parent.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  addText(row, "●", Font.systemFont(7), color);
  row.addSpacer(5);
  addText(row, label, Font.mediumSystemFont(9), PALETTE.muted);
  row.addSpacer();
  addText(row, formatCountdown(resetAt), Font.semiboldSystemFont(10), PALETTE.white);
}

/** 构建中号 Widget，展开 token 与服务端返回的重置倒计时。 */
function buildMediumWidget(payload, offline) {
  const widget = new ListWidget();
  widget.setPadding(13, 15, 12, 15);
  configureBackground(widget);
  addHeader(widget, payload, offline, false);
  widget.addSpacer(8);

  const fiveHour = payload.limits.fiveHour;
  const week = payload.limits.week;
  const content = widget.addStack();
  content.layoutHorizontally();

  const left = content.addStack();
  left.layoutVertically();
  addRingBlock(left, 92, fiveHour, week);
  const legend = left.addStack();
  legend.layoutHorizontally();
  if (fiveHour) addLegendItem(legend, PALETTE.magenta, "5H", fiveHour.remainingPercent);
  if (fiveHour && week) legend.addSpacer(7);
  if (week) addLegendItem(legend, PALETTE.lime, "周", week.remainingPercent);

  content.addSpacer(14);
  const right = content.addStack();
  right.layoutVertically();
  const metrics = right.addStack();
  metrics.layoutHorizontally();
  addMetricCard(metrics, "TOKEN 消耗", formatTokens(payload.tokens && payload.tokens.consumed), PALETTE.white);
  metrics.addSpacer(6);
  addMetricCard(metrics, "TOKEN 剩余", formatTokens(payload.tokens && payload.tokens.remaining), PALETTE.cyan);

  right.addSpacer(8);
  if (fiveHour) addResetRow(right, PALETTE.magenta, "5 小时重置", fiveHour.resetAt);
  if (fiveHour && week) right.addSpacer(5);
  if (week) addResetRow(right, PALETTE.lime, "周额度重置", week.resetAt);
  right.addSpacer();
  addText(right, `数据更新于 ${formatUpdatedAt(payload.updatedAt)}`, Font.mediumSystemFont(8), PALETTE.dim);
  return widget;
}

function buildErrorWidget(message) {
  const widget = new ListWidget();
  widget.setPadding(16, 16, 16, 16);
  configureBackground(widget);
  addText(widget, "CODEX", Font.boldSystemFont(13), PALETTE.white);
  widget.addSpacer();
  addText(widget, "暂无用量数据", Font.boldSystemFont(16), PALETTE.white);
  widget.addSpacer(5);
  addText(widget, message, Font.systemFont(10), PALETTE.muted, 3);
  widget.addSpacer();
  addText(widget, "请在 Scriptable App 内运行脚本检查配置", Font.mediumSystemFont(9), PALETTE.orange);
  return widget;
}

/** 加载数据并按 widgetFamily 渲染。 */
async function main() {
  const previewFamily = args.queryParameters && args.queryParameters.family;
  const family = config.widgetFamily || previewFamily || "medium";
  let widget;

  try {
    const result = await loadUsage();
    widget = family === "small"
      ? buildSmallWidget(result.data, result.offline)
      : buildMediumWidget(result.data, result.offline);
  } catch (error) {
    widget = buildErrorWidget(error.message || String(error));
  }

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
