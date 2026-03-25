const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BASE_URL = "https://cn.2firsts.com/";
const PREVIEW_DIR = path.join(__dirname, "preview");
const RUNS_DIR = path.join(PREVIEW_DIR, "runs");
const WINDOW_HOURS = 48;
const MAX_CANDIDATES = 24;
const MAX_ITEMS = 8;
const DEFAULT_HEADER_NAME = "2F daily report";
const REPORT_EMPTY_MESSAGE = "当日早报页面暂无可解析条目";
const HOT_EMPTY_MESSAGE = `最近${WINDOW_HOURS}小时内暂无新发布文章`;
const FEISHU_RETRY_DELAYS_MS = [30000, 60000, 120000];
const FEISHU_RETRYABLE_CODES = new Set([11232, 19006]);
const HTML_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

class RunLogger {
  constructor() {
    this.lines = [];
  }

  write(level, message) {
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    this.lines.push(line);
    if (level === "ERROR") {
      console.error(line);
      return;
    }
    console.log(line);
  }

  info(message) {
    this.write("INFO", message);
  }

  warn(message) {
    this.write("WARN", message);
  }

  error(message) {
    this.write("ERROR", message);
  }

  toString() {
    return `${this.lines.join("\n")}\n`;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeUtf8(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: "utf8" });
}

function writeJson(filePath, value) {
  writeUtf8(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function cleanEnv(value) {
  return typeof value === "string" ? value.trim() : "";
}

function envFlag(name, defaultValue = false) {
  const raw = cleanEnv(process.env[name]);
  return raw ? /^(1|true|yes|on)$/i.test(raw) : defaultValue;
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text, maxLength) {
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function dedupeBy(items, makeKey) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const key = makeKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }

  return output;
}

function maskEnvPresence(value) {
  return cleanEnv(value) ? "present" : "missing";
}

function buildHeaderName() {
  return DEFAULT_HEADER_NAME;
}

function buildKeywordLine(keyword, headerName) {
  const value = cleanEnv(keyword);
  return value && value !== headerName ? value : "";
}

function getFormatterParts(dateInput, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  });
  const parts = formatter.formatToParts(new Date(dateInput));
  const map = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  return map;
}

function getTodayIsoDate(timeZone) {
  const parts = getFormatterParts(Date.now(), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeTargetDate(value, timeZone) {
  const normalized = cleanEnv(value) || getTodayIsoDate(timeZone);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`TARGET_DATE must be YYYY-MM-DD, received "${normalized || "(empty)"}".`);
  }

  return normalized;
}

function getReferenceTimestamp(targetDate, timeZone) {
  const today = getTodayIsoDate(timeZone);

  if (targetDate === today) {
    return Date.now();
  }

  if (timeZone === "Asia/Shanghai") {
    return Date.parse(`${targetDate}T23:59:59+08:00`);
  }

  return Date.parse(`${targetDate}T23:59:59Z`);
}

function getRunStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function getCnDateParts(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return { year, month, day };
}

function toCnReportLabel(isoDate) {
  const { year, month, day } = getCnDateParts(isoDate);
  return `${month}.${day} ${year}`;
}

function formatDateBare(timestamp, timeZone) {
  const parts = getFormatterParts(timestamp, timeZone);
  return `${Number(parts.year)}-${Number(parts.month)}-${Number(parts.day)}`;
}

function formatDateTimeText(timestamp, timeZone) {
  const parts = getFormatterParts(timestamp, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function decodeHtmlEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith("#")) {
      const isHex = entity[1].toLowerCase() === "x";
      const numeric = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);

      if (!Number.isNaN(numeric)) {
        try {
          return String.fromCodePoint(numeric);
        } catch {
          return match;
        }
      }

      return match;
    }

    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, entity)
      ? HTML_ENTITIES[entity]
      : match;
  });
}

function stripTags(html) {
  return collapseWhitespace(
    decodeHtmlEntities(
      html
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " "),
    ).replace(/\u00a0/g, " "),
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMetaContent(html, key) {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escapeRegExp(key)}["'][^>]+content=(["'])([\\s\\S]*?)\\1[^>]*>`,
    "i",
  );
  const match = html.match(pattern);
  return match ? stripTags(match[2]) : "";
}

function extractTitleTag(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1]) : "";
}

function extractNuxtState(html) {
  const match =
    html.match(/<script>window\.__NUXT__=([\s\S]*?)<\/script>/) ||
    html.match(/<script>__NUXT__=([\s\S]*?)<\/script>/);

  if (!match) {
    return null;
  }

  const source = match[0].replace(/^<script>/, "").replace(/<\/script>$/, "");
  const context = { window: {} };

  vm.createContext(context);
  vm.runInContext(source, context, { timeout: 5000 });
  return context.window.__NUXT__ || context.__NUXT__ || null;
}

function toAbsoluteUrl(value) {
  return new URL(decodeHtmlEntities(value), BASE_URL).href;
}

function normalizeOptionalUrl(value) {
  const raw = cleanEnv(value);
  if (!raw) {
    return "";
  }

  try {
    return toAbsoluteUrl(raw);
  } catch {
    return "";
  }
}

async function fetchText(url, logger) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    logger.info(`Fetching ${url}`);
    const response = await fetch(url, {
      headers: {
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    const bytes = Buffer.from(await response.arrayBuffer());
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    if (!response.ok) {
      throw new Error(`Request failed with HTTP ${response.status} for ${url}`);
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  const raw = cleanEnv(value);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function detectCnReport(targetDate, logger) {
  const reportUrl = `${BASE_URL}report/detail?date=${targetDate}`;

  try {
    const html = await fetchText(reportUrl, logger);
    const nuxt = extractNuxtState(html);
    const report = nuxt?.data?.[0]?.report || null;
    const items = parseJsonArray(report?.content)
      .map((item, index) => {
        const text = truncate(collapseWhitespace(cleanEnv(item?.title || item?.text || "")), 260);
        if (!text) {
          return null;
        }

        return {
          index: index + 1,
          source: collapseWhitespace(cleanEnv(item?.source || "")),
          text,
          url: normalizeOptionalUrl(item?.link || item?.url),
        };
      })
      .filter(Boolean)
      .slice(0, MAX_ITEMS);

    if (items.length === 0) {
      return null;
    }

    const seoUrl = cleanEnv(report?.seo_url);
    return {
      heading: cleanEnv(report?.date_string) ? `早报 / ${report.date_string}` : `早报 / ${toCnReportLabel(targetDate)}`,
      items,
      title:
        cleanEnv(report?.title) ||
        extractMetaContent(html, "og:title") ||
        extractTitleTag(html) ||
        `早报 / ${toCnReportLabel(targetDate)}`,
      url: seoUrl ? new URL(`report/${seoUrl}`, BASE_URL).href : reportUrl,
    };
  } catch (error) {
    logger.warn(`Failed to load Chinese report page for ${targetDate}: ${error.message}`);
    return null;
  }
}

function isArticleLink(href) {
  return href.includes("/news/detail") || /\/news\//.test(href);
}

function isNoiseTitle(title) {
  if (!title || title.length < 8) {
    return true;
  }

  return /^(首页|中国|国际|订阅|中文站|英文站|分享|链接|保存长图|全部|更多|推荐阅读|温馨提示)$/.test(
    title,
  );
}

function cleanupTitle(text) {
  return truncate(collapseWhitespace(text), 220);
}

function extractArticleCandidates(homeHtml) {
  const pattern = /<a\b[^>]*href=(["'])([^"'#]+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  const items = [];
  let match = pattern.exec(homeHtml);

  while (match) {
    const href = match[2].trim();
    if (!href || !isArticleLink(href)) {
      match = pattern.exec(homeHtml);
      continue;
    }

    const title = cleanupTitle(stripTags(match[3]));
    if (!isNoiseTitle(title)) {
      items.push({
        homepageText: stripTags(match[3]),
        title,
        url: toAbsoluteUrl(href),
      });
    }

    match = pattern.exec(homeHtml);
  }

  return dedupeBy(items, (item) => item.url).slice(0, MAX_CANDIDATES);
}

function parsePublishedAtFallback(text, timeZone) {
  const match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})[:：](\d{2}))?/);

  if (!match) {
    return null;
  }

  const year = match[1];
  const month = String(match[2]).padStart(2, "0");
  const day = String(match[3]).padStart(2, "0");
  const hour = String(match[4] || "12").padStart(2, "0");
  const minute = String(match[5] || "00").padStart(2, "0");

  if (timeZone === "Asia/Shanghai") {
    return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:00+08:00`);
  }

  return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:00Z`);
}

async function fetchArticleDetail(url, logger, cache, timeZone) {
  if (cache.has(url)) {
    return cache.get(url);
  }

  const promise = (async () => {
    const html = await fetchText(url, logger);
    const nuxt = extractNuxtState(html);
    const article = nuxt?.data?.[0]?.article || null;
    const rawTitle = article?.title || extractMetaContent(html, "og:title") || extractTitleTag(html);
    const publishedSeconds = Number(article?.push_time || article?.create_time || article?.preview_time || 0);
    const publishedAt =
      publishedSeconds > 0
        ? publishedSeconds * 1000
        : parsePublishedAtFallback(stripTags(article?.content || html), timeZone);
    const canonicalUrl =
      article?.seo_url && !article.seo_url.startsWith("http")
        ? new URL(`news/${article.seo_url}`, BASE_URL).href
        : article?.link
          ? toAbsoluteUrl(article.link)
          : url;

    return {
      id: article?.id || "",
      publishedAt,
      publishedAtDateTimeText: publishedAt ? formatDateTimeText(publishedAt, timeZone) : "",
      publishedAtText: publishedAt ? formatDateBare(publishedAt, timeZone) : "",
      source: cleanEnv(article?.source?.title || ""),
      title: cleanupTitle(rawTitle),
      url: canonicalUrl,
    };
  })().catch((error) => {
    logger.warn(`Failed to parse article detail ${url}: ${error.message}`);
    return null;
  });

  cache.set(url, promise);
  return promise;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const currentIndex = cursor;
      cursor += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker()),
  );

  return results;
}

async function collectRecentArticles(referenceTimestamp, timeZone, logger) {
  const homeHtml = await fetchText(BASE_URL, logger);
  const candidates = extractArticleCandidates(homeHtml);
  const detailCache = new Map();
  const cutoffTimestamp = referenceTimestamp - WINDOW_HOURS * 60 * 60 * 1000;

  logger.info(`Homepage candidates discovered: ${candidates.length}`);
  logger.info(
    `Rolling window: ${formatDateTimeText(cutoffTimestamp, timeZone)} -> ${formatDateTimeText(
      referenceTimestamp,
      timeZone,
    )}`,
  );

  const details = await mapWithConcurrency(candidates, 4, async (candidate) =>
    fetchArticleDetail(candidate.url, logger, detailCache, timeZone),
  );

  const recentItems = dedupeBy(
    details
      .filter(Boolean)
      .filter(
        (item) =>
          typeof item.publishedAt === "number" &&
          item.publishedAt >= cutoffTimestamp &&
          item.publishedAt <= referenceTimestamp,
      )
      .sort((left, right) => right.publishedAt - left.publishedAt),
    (item) => item.id || item.url,
  ).slice(0, MAX_ITEMS);

  return {
    cutoffTimestamp,
    items: recentItems.map((item, index) => ({
      index: index + 1,
      publishedAt: item.publishedAt,
      publishedAtDateTimeText: item.publishedAtDateTimeText,
      publishedAtText: item.publishedAtText,
      source: item.source,
      title: item.title,
      url: item.url,
    })),
  };
}

function toReportMessageItems(items) {
  return items.map((item) => ({
    index: item.index,
    text: item.text,
    meta: item.source,
    url: item.url,
  }));
}

function toRecentMessageItems(items) {
  return items.map((item) => ({
    index: item.index,
    text: item.title,
    meta: item.publishedAtText,
    url: item.url,
  }));
}

function formatMessageRow(item) {
  return `${item.index}. ${item.text}${item.meta ? ` - ${item.meta}` : ""}`;
}

function buildPlainMessage(headerName, keywordLine, targetDate, displayMode, items, emptyMessage, reportUrl) {
  const lines = [headerName];

  if (keywordLine) {
    lines.push(keywordLine);
  }

  lines.push(`｜${targetDate}`);
  lines.push(`模式：${displayMode}`);

  if (items.length === 0) {
    lines.push(emptyMessage);
  } else {
    items.forEach((item) => {
      lines.push(item.url ? `${formatMessageRow(item)} - 查看原文` : formatMessageRow(item));
    });
  }

  if (reportUrl) {
    lines.push("早报页面：查看早报");
  }

  return lines.join("\n");
}

function buildMarkdownMessage(headerName, keywordLine, targetDate, displayMode, items, emptyMessage, reportUrl) {
  const lines = [headerName];

  if (keywordLine) {
    lines.push(keywordLine);
  }

  lines.push(`｜${targetDate}`);
  lines.push(`模式：${displayMode}`);
  lines.push("");

  if (items.length === 0) {
    lines.push(emptyMessage);
  } else {
    items.forEach((item) => {
      lines.push(item.url ? `${formatMessageRow(item)} - [查看原文](${item.url})` : formatMessageRow(item));
    });
  }

  if (reportUrl) {
    lines.push("");
    lines.push(`早报页面：[查看早报](${reportUrl})`);
  }

  return `${lines.join("\n")}\n`;
}

function buildFeishuPostPayload(headerName, keywordLine, targetDate, displayMode, items, emptyMessage, reportUrl) {
  const content = [];

  if (keywordLine) {
    content.push([{ tag: "text", text: keywordLine }]);
  }

  content.push([{ tag: "text", text: `｜${targetDate}` }]);
  content.push([{ tag: "text", text: `模式：${displayMode}` }]);

  if (items.length === 0) {
    content.push([{ tag: "text", text: emptyMessage }]);
  } else {
    items.forEach((item) => {
      const row = [{ tag: "text", text: item.url ? `${formatMessageRow(item)} - ` : formatMessageRow(item) }];
      if (item.url) {
        row.push({ tag: "a", text: "查看原文", href: item.url });
      }
      content.push(row);
    });
  }

  if (reportUrl) {
    content.push([
      { tag: "text", text: "早报页面：" },
      { tag: "a", text: "查看早报", href: reportUrl },
    ]);
  }

  return {
    content: {
      post: {
        zh_cn: {
          content,
          title: headerName,
        },
      },
    },
    msg_type: "post",
  };
}

function resolveWebhookUrl(rawWebhook) {
  if (!rawWebhook) {
    return "";
  }

  return /^https?:\/\//i.test(rawWebhook)
    ? rawWebhook
    : `https://open.feishu.cn/open-apis/bot/v2/hook/${rawWebhook}`;
}

function buildFeishuSignature(secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac("sha256", key).update("").digest("base64");
  return { sign, timestamp };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatRetryDelay(ms) {
  if (ms % 60000 === 0) {
    return `${ms / 60000} min`;
  }

  return `${ms / 1000}s`;
}

function isRetryableFeishuSend(sendResult) {
  if (!sendResult || sendResult.success || !sendResult.attempted) {
    return false;
  }

  const code = Number(sendResult.responseCode);
  const message = cleanEnv(sendResult.responseMessage).toLowerCase();
  const reason = cleanEnv(sendResult.reason).toLowerCase();
  const httpStatus = Number(sendResult.httpStatus);

  return (
    (Number.isFinite(code) && FEISHU_RETRYABLE_CODES.has(code)) ||
    message.includes("frequency limited") ||
    message.includes("internal error") ||
    reason.startsWith("failed to call feishu webhook:") ||
    (Number.isFinite(httpStatus) && httpStatus >= 500)
  );
}

async function sendToFeishu({ logger, payload, secret, webhook, attemptLabel = "" }) {
  const url = resolveWebhookUrl(webhook);

  if (!url) {
    return {
      attempted: false,
      reason: "FEISHU_WEBHOOK is missing, so no message could be sent.",
      responseBody: "",
      responseCode: null,
      responseMessage: "",
      status: "failed",
      success: false,
    };
  }

  const finalPayload = { ...payload };
  if (secret) {
    Object.assign(finalPayload, buildFeishuSignature(secret));
  }

  logger.info(
    `Sending Feishu ${finalPayload.msg_type} message${
      attemptLabel ? ` [${attemptLabel}]` : ""
    } (rows=${finalPayload.content?.post?.zh_cn?.content?.length || 0}, signature=${
      secret ? "enabled" : "disabled"
    })`,
  );

  try {
    const response = await fetch(url, {
      body: JSON.stringify(finalPayload),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.text();
    let parsed = null;

    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }

    const responseCode =
      parsed && typeof parsed === "object" ? parsed.code ?? parsed.StatusCode ?? null : null;
    const responseMessage =
      parsed && typeof parsed === "object"
        ? cleanEnv(parsed.msg || parsed.StatusMessage || "")
        : "";
    const success =
      response.ok &&
      (responseCode === null || Number(responseCode) === 0 || responseMessage === "success");

    return {
      attempted: true,
      httpStatus: response.status,
      reason: success
        ? "Feishu message sent successfully."
        : `Feishu API returned HTTP ${response.status}${
            responseMessage ? ` (${responseMessage})` : ""
          }.`,
      responseBody: truncate(body || "", 2000),
      responseCode,
      responseMessage,
      status: success ? "sent" : "failed",
      success,
    };
  } catch (error) {
    return {
      attempted: true,
      reason: `Failed to call Feishu webhook: ${error.message}`,
      responseBody: "",
      responseCode: null,
      responseMessage: "",
      status: "failed",
      success: false,
    };
  }
}

async function sendToFeishuWithRetry({ logger, payload, secret, webhook }) {
  const totalAttempts = FEISHU_RETRY_DELAYS_MS.length + 1;
  let sendResult = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    sendResult = await sendToFeishu({
      logger,
      payload,
      secret,
      webhook,
      attemptLabel: `${attempt}/${totalAttempts}`,
    });

    if (sendResult.success) {
      return { ...sendResult, attemptCount: attempt, retried: attempt > 1 };
    }

    if (attempt >= totalAttempts || !isRetryableFeishuSend(sendResult)) {
      return { ...sendResult, attemptCount: attempt, retried: attempt > 1 };
    }

    const delayMs = FEISHU_RETRY_DELAYS_MS[attempt - 1];
    const codeText =
      sendResult.responseCode === null || typeof sendResult.responseCode === "undefined"
        ? "n/a"
        : sendResult.responseCode;
    const messageText = sendResult.responseMessage || sendResult.reason || "(empty)";

    logger.warn(
      `Feishu send failed on attempt ${attempt}/${totalAttempts} with code=${codeText}, message=${messageText}. Retrying in ${formatRetryDelay(delayMs)}.`,
    );
    await sleep(delayMs);
  }

  return {
    attempted: false,
    attemptCount: 0,
    retried: false,
    reason: "Feishu send retry wrapper exited unexpectedly.",
    responseBody: "",
    responseCode: null,
    responseMessage: "",
    status: "failed",
    success: false,
  };
}
function buildMarkdown(result) {
  const lines = [
    "# 2Firsts CN Daily Run",
    "",
    `- targetDate: ${result.targetDate}`,
    `- targetDateText: ${result.targetDateText}`,
    `- baseUrl: ${result.baseUrl}`,
    `- mode: ${result.mode}`,
    `- displayMode: ${result.displayMode}`,
    `- contentSource: ${result.contentSource}`,
    `- pushTarget: ${result.pushTarget}`,
    `- matchStrategy: ${result.matchStrategy}`,
    `- referenceTime: ${result.referenceTimeText}`,
  ];

  if (result.windowStartText && result.windowEndText) {
    lines.push(`- windowHours: ${result.windowHours}`);
    lines.push(`- windowStart: ${result.windowStartText}`);
    lines.push(`- windowEnd: ${result.windowEndText}`);
  }

  lines.push(`- itemCount: ${result.itemCount}`);
  lines.push(`- previewOnly: ${result.previewOnly}`);
  lines.push(`- status: ${result.status}`);
  lines.push(`- sendStatus: ${result.send.status}`);
  lines.push(`- sendReason: ${result.send.reason}`);
  lines.push(`- sendAttempts: ${result.send.attemptCount ?? 0}`);
  lines.push(`- sendRetried: ${result.send.retried ? "true" : "false"}`);
  lines.push(`- webhook: ${result.env.FEISHU_WEBHOOK}`);
  lines.push(`- secret: ${result.env.FEISHU_SECRET}`);
  lines.push(`- keyword: ${result.env.FEISHU_KEYWORD}`);
  lines.push("");
  lines.push("## Message Preview");
  lines.push("");
  lines.push(result.messageMarkdown);

  if (result.mode === "morning_report") {
    lines.push("## Extracted Report Items");
    lines.push("");

    if (result.items.length === 0) {
      lines.push(REPORT_EMPTY_MESSAGE);
    } else {
      result.items.forEach((item) => {
        lines.push(
          `${item.index}. ${item.text}${item.source ? ` - ${item.source}` : ""}${
            item.url ? ` - [查看原文](${item.url})` : ""
          }`,
        );
      });
    }

    if (result.report?.url) {
      lines.push("");
      lines.push(`早报页面：[查看早报](${result.report.url})`);
    }
  } else {
    lines.push("## Extracted Articles");
    lines.push("");

    if (result.items.length === 0) {
      lines.push(HOT_EMPTY_MESSAGE);
    } else {
      result.items.forEach((item) => {
        lines.push(
          `${item.index}. ${item.title} - ${item.publishedAtText}${
            item.source ? ` - ${item.source}` : ""
          } - [查看原文](${item.url})`,
        );
      });
    }
  }

  lines.push("");
  lines.push("## Diagnostics");
  lines.push("");
  result.diagnostics.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function finalizeArtifacts({ logger, markdown, result, runStamp }) {
  ensureDir(PREVIEW_DIR);
  ensureDir(RUNS_DIR);

  const runBaseName = `run-${runStamp}`;
  writeJson(path.join(RUNS_DIR, `${runBaseName}.json`), result);
  writeUtf8(path.join(RUNS_DIR, `${runBaseName}.md`), markdown);
  writeUtf8(path.join(RUNS_DIR, `${runBaseName}.log`), logger.toString());
  writeJson(path.join(PREVIEW_DIR, "latest.json"), result);
  writeUtf8(path.join(PREVIEW_DIR, "latest.md"), markdown);
  writeUtf8(path.join(PREVIEW_DIR, "latest.log"), logger.toString());

  logger.info(`Artifacts written to ${PREVIEW_DIR}`);
}

async function run() {
  ensureDir(PREVIEW_DIR);
  ensureDir(RUNS_DIR);

  const logger = new RunLogger();
  const timeZone = cleanEnv(process.env.TIME_ZONE) || "Asia/Shanghai";
  const targetDate = normalizeTargetDate(process.env.TARGET_DATE, timeZone);
  const referenceTimestamp = getReferenceTimestamp(targetDate, timeZone);
  const previewOnly = envFlag("PREVIEW_ONLY", false);
  const feishuWebhook = cleanEnv(process.env.FEISHU_WEBHOOK);
  const feishuSecret = cleanEnv(process.env.FEISHU_SECRET);
  const feishuKeyword = cleanEnv(process.env.FEISHU_KEYWORD);
  const pushTarget = cleanEnv(process.env.PUSH_TARGET) || "UNKNOWN";
  const headerName = buildHeaderName();
  const keywordLine = buildKeywordLine(feishuKeyword, headerName);
  const runStamp = getRunStamp();

  logger.info(`TARGET_DATE=${targetDate}`);
  logger.info(`PREVIEW_ONLY=${previewOnly}`);
  logger.info(`TIME_ZONE=${timeZone}`);
  logger.info(`PUSH_TARGET=${pushTarget}`);
  logger.info(`FEISHU_WEBHOOK=${maskEnvPresence(feishuWebhook)}`);
  logger.info(`FEISHU_SECRET=${maskEnvPresence(feishuSecret)}`);
  logger.info(`FEISHU_KEYWORD=${maskEnvPresence(feishuKeyword)}`);

  const report = await detectCnReport(targetDate, logger);

  let mode = "recent_hot";
  let displayMode = "近期热点";
  let contentSource = "latest_48h";
  let matchStrategy = "latest_48h_empty";
  let items = [];
  let messageItems = [];
  let messageText = "";
  let messageMarkdown = "";
  let feishuPayload = null;
  let diagnostics = [];
  let windowStart = "";
  let windowStartText = "";
  let windowEndText = "";

  if (report) {
    mode = "morning_report";
    displayMode = "早报";
    contentSource = "report_detail";
    matchStrategy = "report_detail";
    items = report.items;
    messageItems = toReportMessageItems(items);
    messageText = buildPlainMessage(
      headerName,
      keywordLine,
      targetDate,
      displayMode,
      messageItems,
      REPORT_EMPTY_MESSAGE,
      report.url,
    );
    messageMarkdown = buildMarkdownMessage(
      headerName,
      keywordLine,
      targetDate,
      displayMode,
      messageItems,
      REPORT_EMPTY_MESSAGE,
      report.url,
    );
    feishuPayload = buildFeishuPostPayload(
      headerName,
      keywordLine,
      targetDate,
      displayMode,
      messageItems,
      REPORT_EMPTY_MESSAGE,
      report.url,
    );
    diagnostics = [
      `Push target ${pushTarget} used the dated report page directly.`,
      "The report page order, summary text, source, and direct article links are preserved in the pushed content.",
      "The report page link is appended at the end of the message for quick backtracking.",
      "preview/latest.json now records both contentSource and pushTarget for debugging.",
    ];
    logger.info(`Morning report items parsed: ${items.length}`);
  } else {
    const recent = await collectRecentArticles(referenceTimestamp, timeZone, logger);
    items = recent.items;
    matchStrategy = recent.items.length > 0 ? "latest_48h" : "latest_48h_empty";
    messageItems = toRecentMessageItems(items);
    messageText = buildPlainMessage(
      headerName,
      keywordLine,
      targetDate,
      displayMode,
      messageItems,
      HOT_EMPTY_MESSAGE,
      "",
    );
    messageMarkdown = buildMarkdownMessage(
      headerName,
      keywordLine,
      targetDate,
      displayMode,
      messageItems,
      HOT_EMPTY_MESSAGE,
      "",
    );
    feishuPayload = buildFeishuPostPayload(
      headerName,
      keywordLine,
      targetDate,
      displayMode,
      messageItems,
      HOT_EMPTY_MESSAGE,
      "",
    );
    windowStart = new Date(recent.cutoffTimestamp).toISOString();
    windowStartText = formatDateTimeText(recent.cutoffTimestamp, timeZone);
    windowEndText = formatDateTimeText(referenceTimestamp, timeZone);
    diagnostics = [
      `Push target ${pushTarget} fell back to the rolling 48-hour article pool because no dated report page was available.`,
      "The fallback list comes from homepage article candidates plus article-detail publish times.",
      "A and B groups may receive different fallback content when they run at different times, which is expected.",
      "preview/latest.json now records both contentSource and pushTarget for debugging.",
    ];
    logger.info(`Recent article count within ${WINDOW_HOURS} hours: ${items.length}`);
  }

  let send = {
    attempted: false,
    attemptCount: 0,
    retried: false,
    reason: "PREVIEW_ONLY=true, message was not sent.",
    responseBody: "",
    responseCode: null,
    responseMessage: "",
    status: "skipped",
    success: false,
  };

  if (!previewOnly) {
    send = await sendToFeishuWithRetry({
      logger,
      payload: feishuPayload,
      secret: feishuSecret,
      webhook: feishuWebhook,
    });
  }

  logger.info(`CONTENT_SOURCE=${contentSource}`);
  logger.info(`Send status=${send.status}`);
  logger.info(`Send reason=${send.reason}`);
  logger.info(`Send attempts=${send.attemptCount}`);
  logger.info(`Send retried=${send.retried}`);

  if (!previewOnly && !feishuWebhook) {
    diagnostics.push("FEISHU_WEBHOOK is missing, so extraction can succeed while sending still fails.");
  }

  if (!previewOnly && feishuWebhook && !feishuSecret) {
    diagnostics.push("If your Feishu bot requires signature verification, an empty FEISHU_SECRET can cause the webhook call to fail.");
  }

  const result = {
    baseUrl: BASE_URL,
    contentSource,
    createdAt: new Date().toISOString(),
    diagnostics,
    displayMode,
    env: {
      FEISHU_KEYWORD: maskEnvPresence(feishuKeyword),
      FEISHU_SECRET: maskEnvPresence(feishuSecret),
      FEISHU_WEBHOOK: maskEnvPresence(feishuWebhook),
      PREVIEW_ONLY: String(previewOnly),
      PUSH_TARGET: pushTarget,
      TARGET_DATE: targetDate,
      TIME_ZONE: timeZone,
    },
    feishuPayload,
    headerName,
    itemCount: items.length,
    items,
    matchStrategy,
    messageMarkdown,
    messageText,
    mode,
    previewOnly,
    pushTarget,
    referenceTime: new Date(referenceTimestamp).toISOString(),
    referenceTimeText: formatDateTimeText(referenceTimestamp, timeZone),
    report,
    send,
    status:
      previewOnly || send.status === "sent"
        ? "success"
        : send.status === "skipped"
          ? "warning"
          : "failed",
    targetDate,
    targetDateText: toCnReportLabel(targetDate),
    windowEndText,
    windowHours: windowStartText ? WINDOW_HOURS : null,
    windowStart,
    windowStartText,
  };

  const markdown = buildMarkdown(result);
  finalizeArtifacts({ logger, markdown, result, runStamp });

  if (!previewOnly && !send.success) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  const logger = new RunLogger();
  const runStamp = getRunStamp();

  logger.error(error.stack || error.message);

  const result = {
    baseUrl: BASE_URL,
    contentSource: "none",
    createdAt: new Date().toISOString(),
    diagnostics: [
      "The run failed before extraction or sending could finish.",
      "Check preview/latest.log for the full stack trace and execution context.",
    ],
    displayMode: "",
    env: {
      FEISHU_KEYWORD: maskEnvPresence(process.env.FEISHU_KEYWORD),
      FEISHU_SECRET: maskEnvPresence(process.env.FEISHU_SECRET),
      FEISHU_WEBHOOK: maskEnvPresence(process.env.FEISHU_WEBHOOK),
      PREVIEW_ONLY: cleanEnv(process.env.PREVIEW_ONLY) || "false",
      PUSH_TARGET: cleanEnv(process.env.PUSH_TARGET) || "UNKNOWN",
      TARGET_DATE: cleanEnv(process.env.TARGET_DATE) || "(auto)",
      TIME_ZONE: cleanEnv(process.env.TIME_ZONE) || "Asia/Shanghai",
    },
    headerName: buildHeaderName(),
    itemCount: 0,
    items: [],
    matchStrategy: "none",
    messageMarkdown: "",
    messageText: "",
    mode: "failed",
    previewOnly: envFlag("PREVIEW_ONLY", false),
    pushTarget: cleanEnv(process.env.PUSH_TARGET) || "UNKNOWN",
    referenceTime: "",
    referenceTimeText: "",
    report: null,
    send: {
      attempted: false,
      attemptCount: 0,
      retried: false,
      reason: error.message,
      responseBody: "",
      responseCode: null,
      responseMessage: "",
      status: "failed",
      success: false,
    },
    status: "failed",
    targetDate: cleanEnv(process.env.TARGET_DATE) || "(auto)",
    targetDateText: "",
    windowEndText: "",
    windowHours: null,
    windowStart: "",
    windowStartText: "",
  };

  const markdown = buildMarkdown(result);
  finalizeArtifacts({ logger, markdown, result, runStamp });
  process.exitCode = 1;
});
