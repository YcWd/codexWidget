"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  classifyUsageWindows,
  extractAccountId,
  normalizeUsage,
  normalizeResetCredits,
  normalizeWindow,
  parseArgs,
} = require("../provider/codex.js");

test("extractAccountId reads the OpenAI auth claim", () => {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
  })).toString("base64url");
  const token = `header.${payload}.signature`;

  assert.equal(extractAccountId({ id_token: token }), "account-test");
});

test("normalizeWindow clamps percentages and calculates reset time", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const result = normalizeWindow({
    used_percent: 120,
    limit_window_seconds: 18_000,
    reset_after_seconds: 3_600,
  }, now);

  assert.equal(result.usedPercent, 100);
  assert.equal(result.remainingPercent, 0);
  assert.equal(result.resetAt, "2026-07-15T01:00:00.000Z");
  assert.equal(result.resetInSeconds, 3_600);
});

test("normalizeUsage produces the stable schema", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const result = normalizeUsage({
    plan_type: "plus",
    rate_limit_reset_credits: { available_count: 2 },
    rate_limit: {
      primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_768_000_000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: 1_768_500_000 },
    },
  }, { consumed: 100, remaining: 200 }, now);

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.account.plan, "plus");
  assert.equal(result.limits.fiveHour.remainingPercent, 80);
  assert.equal(result.limits.week.remainingPercent, 60);
  assert.deepEqual(result.tokens, { consumed: 100, remaining: 200 });
  assert.deepEqual(result.resetCredits, { availableCount: 2 });
});

test("normalizeResetCredits keeps the available reset count", () => {
  assert.deepEqual(normalizeResetCredits({ available_count: 2 }), { availableCount: 2 });
  assert.equal(normalizeResetCredits(null), null);
});

test("normalizeUsage accepts a weekly-only primary window", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const result = normalizeUsage({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 604_800, reset_at: 1_768_500_000 },
      secondary_window: null,
    },
  }, null, now);

  assert.equal(result.limits.fiveHour, null);
  assert.equal(result.limits.week.remainingPercent, 75);
});

test("classifyUsageWindows preserves an unlabelled primary and secondary pair", () => {
  const primary = { used_percent: 10 };
  const secondary = { used_percent: 20 };

  assert.deepEqual(classifyUsageWindows({ primary_window: primary, secondary_window: secondary }), {
    fiveHour: primary,
    week: secondary,
  });
});

test("parseArgs rejects an option without a path", () => {
  assert.throws(() => parseArgs(["--output"]), /--output 缺少路径/);
});
