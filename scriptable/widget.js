// Codex Usage · Scriptable Widget
// 将本文件复制到 Scriptable；usage.json 放入 Scriptable iCloud Documents 根目录。

const SETTINGS = {
  dataURL: "",
  localFile: "usage.json",
  requestTimeout: 12,
  refreshMinutes: 15,
  staleMinutes: 45,
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
    data.limits.fiveHour &&
    data.limits.week
  );
}

/** 优先拉取参数 URL，失败时回退 iCloud 缓存。 */
async function loadUsage() {
  const cached = await readLocalUsage();
  const parameter = typeof args.widgetParameter === "string" ? args.widgetParameter.trim() : "";
  const dataURL = parameter || SETTINGS.dataURL;
  let data = cached;
  let cacheFallback = false;

  if (dataURL) {
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
      await saveLocalUsage(remote);
    } catch (error) {
      if (!cached) throw error;
      data = cached;
      cacheFallback = true;
    }
  }

  if (!isValidUsage(data)) throw new Error("未找到有效的 usage.json");
  const updatedAt = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
  const ageMinutes = updatedAt ? (Date.now() - updatedAt) / 60000 : Infinity;
  return {
    data,
    offline: Boolean(data.offline || cacheFallback || ageMinutes > SETTINGS.staleMinutes),
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

/** 生成 5 小时与周额度双圆环图片。 */
function activityRingsImage(size, fiveHour, week) {
  const context = new DrawContext();
  context.size = new Size(size, size);
  context.opaque = false;
  context.respectScreenScale = true;
  const center = size / 2;

  drawRing(context, center, size * 0.39, size * 0.095, fiveHour, [255, 55, 95], [255, 159, 10]);
  drawRing(context, center, size * 0.265, size * 0.085, week, [183, 247, 0], [48, 216, 200]);
  return context.getImage();
}

function formatTokens(value) {
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

function addRingBlock(parent, size, fiveHour, week) {
  const ring = parent.addStack();
  ring.size = new Size(size, size);
  ring.backgroundImage = activityRingsImage(size, fiveHour, week);
  ring.layoutVertically();
  ring.setPadding(size * 0.34, 0, 0, 0);
  const value = addText(ring, `${Math.round(fiveHour)}%`, Font.boldSystemFont(size * 0.18), PALETTE.white);
  value.centerAlignText();
  const label = addText(ring, "5H 剩余", Font.semiboldSystemFont(size * 0.075), PALETTE.muted);
  label.centerAlignText();
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

/** 构建小号 Widget，压缩展示所有核心指标。 */
function buildSmallWidget(payload, offline) {
  const widget = new ListWidget();
  widget.setPadding(10, 11, 9, 11);
  configureBackground(widget);
  addHeader(widget, payload, offline, true);
  widget.addSpacer(3);

  const fiveHour = payload.limits.fiveHour.remainingPercent;
  const week = payload.limits.week.remainingPercent;
  const ringRow = widget.addStack();
  ringRow.addSpacer();
  addRingBlock(ringRow, 74, fiveHour, week);
  ringRow.addSpacer();

  const legend = widget.addStack();
  legend.layoutHorizontally();
  legend.centerAlignContent();
  legend.addSpacer();
  addLegendItem(legend, PALETTE.magenta, "5H", fiveHour);
  legend.addSpacer(8);
  addLegendItem(legend, PALETTE.lime, "周", week);
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
  addText(footer, `5H 重置 ${formatCountdown(payload.limits.fiveHour.resetAt)}`, Font.mediumSystemFont(8), PALETTE.muted);
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

/** 构建中号 Widget，展开 token 与双窗口倒计时。 */
function buildMediumWidget(payload, offline) {
  const widget = new ListWidget();
  widget.setPadding(13, 15, 12, 15);
  configureBackground(widget);
  addHeader(widget, payload, offline, false);
  widget.addSpacer(8);

  const fiveHour = payload.limits.fiveHour.remainingPercent;
  const week = payload.limits.week.remainingPercent;
  const content = widget.addStack();
  content.layoutHorizontally();

  const left = content.addStack();
  left.layoutVertically();
  addRingBlock(left, 92, fiveHour, week);
  const legend = left.addStack();
  legend.layoutHorizontally();
  addLegendItem(legend, PALETTE.magenta, "5H", fiveHour);
  legend.addSpacer(7);
  addLegendItem(legend, PALETTE.lime, "周", week);

  content.addSpacer(14);
  const right = content.addStack();
  right.layoutVertically();
  const metrics = right.addStack();
  metrics.layoutHorizontally();
  addMetricCard(metrics, "TOKEN 消耗", formatTokens(payload.tokens && payload.tokens.consumed), PALETTE.white);
  metrics.addSpacer(6);
  addMetricCard(metrics, "TOKEN 剩余", formatTokens(payload.tokens && payload.tokens.remaining), PALETTE.cyan);

  right.addSpacer(8);
  addResetRow(right, PALETTE.magenta, "5 小时重置", payload.limits.fiveHour.resetAt);
  right.addSpacer(5);
  addResetRow(right, PALETTE.lime, "周额度重置", payload.limits.week.resetAt);
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
  addText(widget, "请同步 usage.json 后刷新", Font.mediumSystemFont(9), PALETTE.orange);
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
