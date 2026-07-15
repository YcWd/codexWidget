#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_OUTPUT = path.resolve(__dirname, "..", "data", "usage.json");
const DEFAULT_USAGE_URLS = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/backend-api/codex/usage",
];
const TOKEN_URL = process.env.CODEX_USAGE_TOKEN_URL || "https://auth.openai.com/oauth/token";
const CLIENT_ID = process.env.CODEX_USAGE_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";
const REQUEST_TIMEOUT_MS = 20_000;

class ProviderError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
  }
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const options = {
    authPath: process.env.CODEX_AUTH_PATH || null,
    outputPath: process.env.CODEX_USAGE_OUTPUT || DEFAULT_OUTPUT,
    refreshOnUnauthorized: true,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--auth") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new ProviderError("ARGUMENT", "--auth 缺少路径");
      options.authPath = value;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new ProviderError("ARGUMENT", "--output 缺少路径");
      options.outputPath = value;
    } else if (argument === "--no-refresh") {
      options.refreshOnUnauthorized = false;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new ProviderError("ARGUMENT", `未知参数: ${argument}`);
    }
  }

  return options;
}

/** 解码 JWT payload，用于提取 account id。 */
function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const segments = token.split(".");
  if (segments.length < 2) return null;

  try {
    return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** 从认证字段或 JWT claim 中解析 ChatGPT account id。 */
function extractAccountId(tokens) {
  if (tokens.account_id) return tokens.account_id;
  const payloads = [decodeJwtPayload(tokens.id_token), decodeJwtPayload(tokens.access_token)];
  for (const payload of payloads) {
    const authClaim = payload && payload["https://api.openai.com/auth"];
    if (authClaim && authClaim.chatgpt_account_id) return authClaim.chatgpt_account_id;
  }
  return null;
}

/** 读取 Codex auth.json；未指定时优先 ~/.codex/auth.json。 */
async function loadAuth(explicitPath) {
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : [
        path.join(os.homedir(), ".codex", "auth.json"),
        path.join(os.homedir(), ".hermes", "auth.json"),
      ];
  const errors = [];

  for (const authPath of candidates) {
    let data;
    try {
      data = JSON.parse(await fs.readFile(authPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") errors.push(`${authPath}: ${error.message}`);
      continue;
    }

    let tokens = data.tokens;
    let kind = "codex";
    if (!tokens && data.credential_pool && Array.isArray(data.credential_pool["openai-codex"])) {
      tokens = data.credential_pool["openai-codex"][0];
      kind = "hermes";
    }
    if (!tokens || !tokens.access_token) {
      errors.push(`${authPath}: 缺少 access_token`);
      continue;
    }

    return {
      authPath,
      data,
      kind,
      tokens,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      accountId: extractAccountId(tokens),
    };
  }

  const detail = errors.length ? `；${errors.join("；")}` : "";
  throw new ProviderError("AUTH", `未找到可用认证信息（已优先检查 ~/.codex/auth.json）${detail}`);
}

/** 发起带超时的 JSON 请求。 */
async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    const message = error.name === "AbortError" ? "请求超时" : error.message;
    throw new ProviderError("NETWORK", `${message}: ${url}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ProviderError("PARSE", `接口返回了非 JSON 内容: HTTP ${response.status}`, response.status);
    }
  }

  if (!response.ok) {
    const message = body && (body.error_description || body.error && body.error.message || body.detail);
    throw new ProviderError(
      response.status === 401 ? "UNAUTHORIZED" : "API",
      message || `接口请求失败: HTTP ${response.status}`,
      response.status,
    );
  }
  return body;
}

/** 构造 Codex usage 请求头。 */
function buildUsageHeaders(accessToken, accountId) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/codex",
    "User-Agent": "codex-cli",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

/** 依次请求兼容的 Codex usage 地址。 */
async function fetchUsage(accessToken, accountId) {
  const configuredUrls = process.env.CODEX_USAGE_URLS
    ? process.env.CODEX_USAGE_URLS.split(";").map((value) => value.trim()).filter(Boolean)
    : DEFAULT_USAGE_URLS;
  let lastError = null;

  for (const url of configuredUrls) {
    try {
      const usage = await requestJson(url, { headers: buildUsageHeaders(accessToken, accountId) });
      if (!usage || !usage.rate_limit) {
        throw new ProviderError("PARSE", `usage 响应缺少 rate_limit: ${url}`);
      }
      return usage;
    } catch (error) {
      if (error.code === "UNAUTHORIZED") throw error;
      lastError = error;
    }
  }

  throw lastError || new ProviderError("API", "没有可用的 Codex usage 地址");
}

/** 原子写入 JSON 文件。 */
async function writeJsonAtomic(filePath, value) {
  const absolutePath = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, absolutePath);
}

/** 刷新 access token 并写回原 auth.json。 */
async function refreshAuth(auth) {
  if (!auth.refreshToken) {
    throw new ProviderError("AUTH", "access token 已失效，且 auth.json 中没有 refresh_token");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
    client_id: CLIENT_ID,
  });
  const refreshed = await requestJson(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!refreshed || !refreshed.access_token) {
    throw new ProviderError("AUTH", "token 刷新成功，但响应缺少 access_token");
  }

  const newTokens = {
    ...auth.tokens,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || auth.tokens.refresh_token,
    id_token: refreshed.id_token || auth.tokens.id_token,
  };
  if (auth.kind === "codex") {
    auth.data.tokens = newTokens;
  } else {
    auth.data.credential_pool["openai-codex"][0] = newTokens;
  }
  await writeJsonAtomic(auth.authPath, auth.data);

  return {
    ...auth,
    tokens: newTokens,
    accessToken: newTokens.access_token,
    refreshToken: newTokens.refresh_token || null,
    accountId: extractAccountId(newTokens),
  };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.min(100, Math.max(0, number)) * 10) / 10;
}

/** 将接口窗口转换为稳定的 JSON 字段。 */
function normalizeWindow(window, now) {
  if (!window) return null;
  const usedPercent = clampPercent(window.used_percent);
  const resetSeconds = Math.max(0, Number(window.reset_after_seconds) || 0);
  const resetTimestamp = Number(window.reset_at) || (resetSeconds ? now.getTime() / 1000 + resetSeconds : 0);
  return {
    usedPercent,
    remainingPercent: Math.round((100 - usedPercent) * 10) / 10,
    windowSeconds: Math.max(0, Number(window.limit_window_seconds) || 0),
    resetAt: resetTimestamp ? new Date(resetTimestamp * 1000).toISOString() : null,
    resetInSeconds: resetTimestamp ? Math.max(0, Math.round(resetTimestamp - now.getTime() / 1000)) : 0,
  };
}

/** 将原始 usage 响应转换为标准输出结构。 */
function normalizeUsage(usage, tokenUsage, now = new Date()) {
  const limits = usage.rate_limit || {};
  const credits = usage.credits;
  return {
    schemaVersion: 1,
    ok: true,
    offline: false,
    source: "live",
    updatedAt: now.toISOString(),
    checkedAt: now.toISOString(),
    account: {
      plan: String(usage.plan_type || usage.account_plan || "unknown"),
    },
    limits: {
      fiveHour: normalizeWindow(limits.primary_window, now),
      week: normalizeWindow(limits.secondary_window, now),
    },
    tokens: tokenUsage,
    credits: credits == null ? null : credits,
    error: null,
  };
}

/** 查找 sessions 目录中字典序最新的 JSONL 文件。 */
async function findLatestSessionFile(rootPath) {
  let latest = null;
  const pending = [rootPath];

  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && (!latest || entryPath > latest)) {
        latest = entryPath;
      }
    }
  }
  return latest;
}

/** 从最新 session 的 token_count 事件读取 token 数据。 */
async function readLatestTokenUsage() {
  const sessionFile = await findLatestSessionFile(path.join(os.homedir(), ".codex", "sessions"));
  if (!sessionFile) return null;
  const lines = (await fs.readFile(sessionFile, "utf8")).trimEnd().split("\n");

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    const payload = event.payload || event;
    if (payload.type !== "token_count" || !payload.info) continue;

    const info = payload.info;
    const total = info.total_token_usage || {};
    const last = info.last_token_usage || {};
    const contextWindow = Number(info.model_context_window) || null;
    const contextUsed = Number(last.total_tokens) || null;
    return {
      source: "latestSession",
      consumed: Number(total.total_tokens) || 0,
      remaining: contextWindow && contextUsed != null ? Math.max(0, contextWindow - contextUsed) : null,
      contextUsed,
      contextWindow,
      input: Number(total.input_tokens) || 0,
      cachedInput: Number(total.cached_input_tokens) || 0,
      output: Number(total.output_tokens) || 0,
      reasoningOutput: Number(total.reasoning_output_tokens) || 0,
      capturedAt: event.timestamp || null,
    };
  }
  return null;
}

/** 读取现有输出作为离线缓存。 */
async function loadCache(outputPath) {
  try {
    const cache = JSON.parse(await fs.readFile(path.resolve(outputPath), "utf8"));
    return cache && cache.schemaVersion === 1 && cache.limits ? cache : null;
  } catch {
    return null;
  }
}

/** 将错误转换为可公开写入 usage.json 的结构。 */
function serializeError(error) {
  return {
    code: error.code || "UNKNOWN",
    message: error.message || String(error),
    status: error.status || null,
  };
}

function printHelp() {
  process.stdout.write(`Codex usage provider\n\n` +
    `用法: node provider/codex.js [options]\n\n` +
    `  --auth <path>    指定 auth.json（默认优先 ~/.codex/auth.json）\n` +
    `  --output <path>  指定 JSON 输出（默认 data/usage.json）\n` +
    `  --no-refresh     401 时不刷新 token\n` +
    `  -h, --help       显示帮助\n`);
}

/** 执行数据读取、刷新、标准化与缓存。 */
async function run(options) {
  const previous = await loadCache(options.outputPath);
  let auth = await loadAuth(options.authPath);
  let usage;

  try {
    usage = await fetchUsage(auth.accessToken, auth.accountId);
  } catch (error) {
    if (error.code !== "UNAUTHORIZED" || !options.refreshOnUnauthorized) throw error;
    auth = await refreshAuth(auth);
    usage = await fetchUsage(auth.accessToken, auth.accountId);
  }

  const tokenUsage = await readLatestTokenUsage();
  const result = normalizeUsage(usage, tokenUsage);
  await writeJsonAtomic(options.outputPath, result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

/** CLI 入口：失败时输出缓存或标准错误 JSON。 */
async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      printHelp();
      return 0;
    }
    return await run(options);
  } catch (error) {
    const outputPath = options && options.outputPath ? options.outputPath : DEFAULT_OUTPUT;
    const cached = await loadCache(outputPath);
    const checkedAt = new Date().toISOString();
    const result = cached
      ? {
          ...cached,
          ok: false,
          offline: true,
          source: "cache",
          checkedAt,
          error: serializeError(error),
        }
      : {
          schemaVersion: 1,
          ok: false,
          offline: true,
          source: "unavailable",
          updatedAt: null,
          checkedAt,
          account: { plan: "unknown" },
          limits: { fiveHour: null, week: null },
          tokens: null,
          credits: null,
          error: serializeError(error),
        };

    await writeJsonAtomic(outputPath, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return cached ? 0 : 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  extractAccountId,
  normalizeUsage,
  normalizeWindow,
  parseArgs,
  serializeError,
};
