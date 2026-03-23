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
const HTML_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};
const REPORT_STOP_TITLES = new Set([
  "推荐阅读",
  "相关阅读",
  "热门资讯",
  "地区资讯",
  "专题报道",
  "特别报道",
  "产品",
  "快讯",
  "厂商",
  "合规",
]);
const REPORT_NOISE_PATTERNS = [
  /^0$/,
  /^分享$/,
  /^链接$/,
  /^保存长图$/,
  /^前一天$/,
  /^后一天$/,
  /^选择日期$/,
  /^<前一天\s*选择日期$/,
  /^本网站仅供国际用户访问/,
  /^首页$/,
  /^订阅$/,
  /^中文站$/,
  /^英文站/,
  /^原创$/,
  /^中国$/,
  /^国际$/,
];

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
  return { day, month, year };
}

function toCnReportLabel(isoDate) {
  const { day, month, year } = getCnDateParts(isoDate);
  return `${month}.${day} ${year}`;
}

function toCnReportCompactLabel(isoDate) {
  const { day, month, year } = getCnDateParts(isoDate);
  return `${month}.${day}${year}`;
}

function collapseWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
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

function truncate(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
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

function toAbsoluteUrl(href) {
  return new URL(decodeHtmlEntities(href), BASE_URL).href;
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

function extractTextBlocks(html) {
  return [...html.matchAll(/<(p|li|h1|h2|h3|div)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => stripTags(match[2]))
    .filter(Boolean);
}

function isReportNoiseBlock(text) {
  return REPORT_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

function isReportStopBlock(text) {
  return REPORT_STOP_TITLES.has(text);
}

function findReportHeadingIndex(blocks, isoDate) {
  const expectedA = `早报/${toCnReportLabel(isoDate)}`.replace(/\s+/g, "");
  const expectedB = `早报/${toCnReportCompactLabel(isoDate)}`.replace(/\s+/g, "");

  return blocks.findIndex((block) => {
    const normalized = block.replace(/\s+/g, "");
    return normalized === expectedA || normalized === expectedB;
  });
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

function formatDateBare(timestamp, timeZone) {
  const parts = getFormatterParts(timestamp, timeZone);
  return `${Number(parts.year)}-${Number(parts.month)}-${Number(parts.day)}`;
}

function formatDateTimeText(timestamp, timeZone) {
  const parts = getFormatterParts(timestamp, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
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

async function detectCnReport(targetDate, logger) {
  const reportUrl = `${BASE_URL}report/detail?date=${targetDate}`;

  try {
    const html = await fetchText(reportUrl, logger);
    const blocks = extractTextBlocks(html);
    const headingIndex = findReportHeadingIndex(blocks, targetDate);

    if (headingIndex < 0) {
      return null;
    }

    return {
      heading: blocks[headingIndex],
      title: extractMetaContent(html, "og:title") || extractTitleTag(html) || `早报 / ${toCnReportLabel(targetDate)}`,
      url: reportUrl,
    };
  } catch (error) {
    logger.warn(`Failed to load Chinese report page for ${targetDate}: ${error.message}`);
    return null;
  }
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
    const publishedSeconds = Number(
      article?.push_time || article?.create_time || article?.preview_time || 0,
    );
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

async function collectRecentArticles(homeHtml, referenceTimestamp, timeZone, logger) {
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
    inspectedCount: details.filter(Boolean).length,
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

function maskEnvPresence(value) {
  return cleanEnv(value) ? "present" : "missing";
}

function resolveWebhookUrl(rawWebhook) {
  if (!rawWebhook) {
    return "";
  }

  if (/^https?:\/\//i.test(rawWebhook)) {
    return rawWebhook;
  }

  return `https://open.feishu.cn/open-apis/bot/v2/hook/${rawWebhook}`;
}

function buildFeishuSignature(secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac("sha256", key).update("").digest("base64");
  return { sign, timestamp };
}

function buildHeaderName(keyword) {
  return cleanEnv(keyword) || "2F早报";
}

function buildPlainMessage(headerName, targetDate, displayMode, items) {
  const lines = [headerName, `｜${targetDate}`, `模式：${displayMode}`];

  if (items.length === 0) {
    lines.push(`最近${WINDOW_HOURS}小时内暂无新发布文章`);
    return lines.join("\n");
  }

  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title} - ${item.publishedAtText} - 查看原文`);
  });

  return lines.join("\n");
}

function buildMarkdownMessage(headerName, targetDate, displayMode, items) {
  const lines = [headerName, `｜${targetDate}`, `模式：${displayMode}`, ""];

  if (items.length === 0) {
    lines.push(`最近${WINDOW_HOURS}小时内暂无新发布文章`);
    return `${lines.join("\n")}\n`;
  }

  items.forEach((item, index) => {
    lines.push(
      `${index + 1}. ${item.title} - ${item.publishedAtText} - [查看原文](${item.url})`,
    );
  });

  return `${lines.join("\n")}\n`;
}

function buildFeishuPostPayload(headerName, targetDate, displayMode, items) {
  const content = [
    [{ tag: "text", text: `｜${targetDate}` }],
    [{ tag: "text", text: `模式：${displayMode}` }],
  ];

  if (items.length === 0) {
    content.push([{ tag: "text", text: `最近${WINDOW_HOURS}小时内暂无新发布文章` }]);
  } else {
    items.forEach((item, index) => {
      content.push([
        {
          tag: "text",
          text: `${index + 1}. ${item.title} - ${item.publishedAtText} - `,
        },
        {
          tag: "a",
          text: "查看原文",
          href: item.url,
        },
      ]);
    });
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

async function sendToFeishu({ logger, payload, secret, webhook }) {
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
    `Sending Feishu ${finalPayload.msg_type} message (rows=${
      finalPayload.content?.post?.zh_cn?.content?.length || 0
    }, signature=${secret ? "enabled" : "disabled"})`,
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

function buildMarkdown(result) {
  const lines = [
    "# 2Firsts CN Daily Run",
    "",
    `- targetDate: ${result.targetDate}`,
    `- targetDateText: ${result.targetDateText}`,
    `- baseUrl: ${result.baseUrl}`,
    `- mode: ${result.mode}`,
    `- displayMode: ${result.displayMode}`,
    `- matchStrategy: ${result.matchStrategy}`,
    `- referenceTime: ${result.referenceTimeText}`,
    `- windowHours: ${result.windowHours}`,
    `- windowStart: ${result.windowStartText}`,
    `- windowEnd: ${result.windowEndText}`,
    `- itemCount: ${result.itemCount}`,
    `- previewOnly: ${result.previewOnly}`,
    `- status: ${result.status}`,
    `- sendStatus: ${result.send.status}`,
    `- sendReason: ${result.send.reason}`,
    `- webhook: ${result.env.FEISHU_WEBHOOK}`,
    `- secret: ${result.env.FEISHU_SECRET}`,
    `- keyword: ${result.env.FEISHU_KEYWORD}`,
    "",
    "## Message Preview",
    "",
    result.messageMarkdown,
  ];

  if (result.report) {
    lines.push("## Report Marker");
    lines.push("");
    lines.push(`- title: ${result.report.title}`);
    lines.push(`- heading: ${result.report.heading}`);
    lines.push(`- url: ${result.report.url}`);
    lines.push("");
  }

  lines.push("## Extracted Articles");
  lines.push("");

  if (result.items.length === 0) {
    lines.push(`最近${WINDOW_HOURS}小时内暂无新发布文章`);
  } else {
    result.items.forEach((item, index) => {
      lines.push(
        `${index + 1}. ${item.title} - ${item.publishedAtText}${
          item.source ? ` - ${item.source}` : ""
        } - [查看原文](${item.url})`,
      );
    });
  }

  lines.push("");
  lines.push("## Diagnostics");
  lines.push("");
  result.diagnostics.forEach((item, index) => {
    lines.push(`${index + 1}. ${item}`);
  });
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
  const targetDateText = toCnReportLabel(targetDate);
  const referenceTimestamp = getReferenceTimestamp(targetDate, timeZone);
  const previewOnly = envFlag("PREVIEW_ONLY", false);
  const feishuWebhook = cleanEnv(process.env.FEISHU_WEBHOOK);
  const feishuSecret = cleanEnv(process.env.FEISHU_SECRET);
  const feishuKeyword = cleanEnv(process.env.FEISHU_KEYWORD);
  const headerName = buildHeaderName(feishuKeyword);
  const runStamp = getRunStamp();

  logger.info(`BASE_URL=${BASE_URL}`);
  logger.info(`TARGET_DATE=${targetDate}`);
  logger.info(`TARGET_DATE_TEXT=${targetDateText}`);
  logger.info(`REFERENCE_TIME=${formatDateTimeText(referenceTimestamp, timeZone)}`);
  logger.info(`PREVIEW_ONLY=${previewOnly}`);
  logger.info(`TIME_ZONE=${timeZone}`);
  logger.info(`FEISHU_WEBHOOK=${maskEnvPresence(feishuWebhook)}`);
  logger.info(`FEISHU_SECRET=${maskEnvPresence(feishuSecret)}`);
  logger.info(`FEISHU_KEYWORD=${maskEnvPresence(feishuKeyword)}`);

  const report = await detectCnReport(targetDate, logger);
  const homeHtml = await fetchText(BASE_URL, logger);
  const recent = await collectRecentArticles(homeHtml, referenceTimestamp, timeZone, logger);
  const mode = report ? "morning_report" : "recent_hot";
  const displayMode = report ? "早报" : "近期热点";
  const matchStrategy = recent.items.length > 0 ? "latest_48h" : "latest_48h_empty";
  const messageText = buildPlainMessage(headerName, targetDate, displayMode, recent.items);
  const messageMarkdown = buildMarkdownMessage(
    headerName,
    targetDate,
    displayMode,
    recent.items,
  );
  const feishuPayload = buildFeishuPostPayload(
    headerName,
    targetDate,
    displayMode,
    recent.items,
  );

  logger.info(`Recent article count within ${WINDOW_HOURS} hours: ${recent.items.length}`);

  let send = {
    attempted: false,
    reason: "PREVIEW_ONLY=true, message was not sent.",
    responseBody: "",
    responseCode: null,
    responseMessage: "",
    status: "skipped",
    success: false,
  };

  if (!previewOnly) {
    send = await sendToFeishu({
      logger,
      payload: feishuPayload,
      secret: feishuSecret,
      webhook: feishuWebhook,
    });
  }

  logger.info(`Send status=${send.status}`);
  logger.info(`Send reason=${send.reason}`);

  const diagnostics = [
    "Content now comes from articles published within the latest 48 hours of the reference time, not from 'today/homepage latest' ordering.",
    "Mode label only controls whether the run is tagged as 早报 or 近期热点; the pushed item list always comes from the rolling 48-hour article window.",
    "The script checks /report/detail?date=YYYY-MM-DD to decide whether to label the run as 早报.",
    "Each pushed item now includes the 2Firsts publish date and is sent as a Feishu rich-text post with a clickable '查看原文' link.",
    "This run always writes preview/latest.json, preview/latest.md, and preview/latest.log so you can inspect extracted items even when Feishu sending fails.",
  ];

  if (recent.items.length === 0) {
    diagnostics.push(`No articles were found inside the last ${WINDOW_HOURS} hours.`);
  }

  if (!previewOnly && !feishuWebhook) {
    diagnostics.push("FEISHU_WEBHOOK is missing, so extraction can succeed while sending still fails.");
  }

  if (!previewOnly && feishuWebhook && !feishuSecret) {
    diagnostics.push(
      "If your Feishu bot requires signature verification, an empty FEISHU_SECRET can cause the webhook call to fail.",
    );
  }

  const result = {
    baseUrl: BASE_URL,
    createdAt: new Date().toISOString(),
    diagnostics,
    displayMode,
    env: {
      FEISHU_KEYWORD: maskEnvPresence(feishuKeyword),
      FEISHU_SECRET: maskEnvPresence(feishuSecret),
      FEISHU_WEBHOOK: maskEnvPresence(feishuWebhook),
      PREVIEW_ONLY: String(previewOnly),
      TARGET_DATE: targetDate,
      TIME_ZONE: timeZone,
    },
    feishuPayload,
    headerName,
    itemCount: recent.items.length,
    items: recent.items,
    matchStrategy,
    messageMarkdown,
    messageText,
    mode,
    previewOnly,
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
    targetDateText,
    windowEndText: formatDateTimeText(referenceTimestamp, timeZone),
    windowHours: WINDOW_HOURS,
    windowStart: new Date(recent.cutoffTimestamp).toISOString(),
    windowStartText: formatDateTimeText(recent.cutoffTimestamp, timeZone),
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
      TARGET_DATE: cleanEnv(process.env.TARGET_DATE) || "(auto)",
      TIME_ZONE: cleanEnv(process.env.TIME_ZONE) || "Asia/Shanghai",
    },
    headerName: buildHeaderName(process.env.FEISHU_KEYWORD),
    itemCount: 0,
    items: [],
    matchStrategy: "none",
    messageMarkdown: "",
    messageText: "",
    mode: "failed",
    previewOnly: envFlag("PREVIEW_ONLY", false),
    referenceTime: "",
    referenceTimeText: "",
    report: null,
    send: {
      attempted: false,
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
    windowHours: WINDOW_HOURS,
    windowStart: "",
    windowStartText: "",
  };
  const markdown = buildMarkdown(result);

  finalizeArtifacts({ logger, markdown, result, runStamp });
  process.exitCode = 1;
});
