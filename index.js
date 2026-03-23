const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://cn.2firsts.com/";
const PREVIEW_DIR = path.join(__dirname, "preview");
const RUNS_DIR = path.join(PREVIEW_DIR, "runs");
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
  if (!raw) {
    return defaultValue;
  }

  return /^(1|true|yes|on)$/i.test(raw);
}

function getTodayIsoDate(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(new Date());
  const map = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  return `${map.year}-${map.month}-${map.day}`;
}

function normalizeTargetDate(value, timeZone) {
  const normalized = cleanEnv(value) || getTodayIsoDate(timeZone);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`TARGET_DATE must be YYYY-MM-DD, received "${normalized || "(empty)"}".`);
  }

  return normalized;
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

function toCnCardDate(isoDate) {
  const { day, month } = getCnDateParts(isoDate);
  return `${month}-${day}`;
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
  return new URL(href, BASE_URL).href;
}

function isArticleLink(href) {
  return href.includes("/news/detail") || /\/news\//.test(href);
}

function extractDateToken(text) {
  const matchers = [
    /\b\d{2}\.\d{2}\s*\d{4}\b/,
    /\b\d{2}-\d{2}\b/,
    /\b\d+\s*(分钟前|小时前|天前)\b/,
  ];

  for (const pattern of matchers) {
    const match = text.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return "";
}

function cleanupTitle(text) {
  let title = collapseWhitespace(text);

  title = title
    .replace(/\s+\d{2}\.\d{2}\s*\d{4}\s*$/g, "")
    .replace(/\s+\d{2}-\d{2}\s*$/g, "")
    .replace(/\s+\d+\s*(分钟前|小时前|天前)\s*$/g, "")
    .replace(/\s+(中国|国际|资讯|产品|快讯|厂商)\s+\d{2}-\d{2}\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return truncate(title, 220);
}

function isNoiseTitle(title) {
  if (!title || title.length < 8) {
    return true;
  }

  return /^(首页|中国|国际|订阅|中文站|英文站|分享|链接|保存长图|全部|更多|推荐阅读|温馨提示)$/.test(title);
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

function extractArticleLinks(html) {
  const pattern = /<a\b[^>]*href=(["'])([^"'#]+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  const items = [];
  let match = pattern.exec(html);

  while (match) {
    const href = match[2].trim();
    if (!href || !isArticleLink(href)) {
      match = pattern.exec(html);
      continue;
    }

    const rawText = stripTags(match[3]);
    const title = cleanupTitle(rawText);
    const dateText = extractDateToken(rawText);

    if (!isNoiseTitle(title)) {
      items.push({
        dateText,
        rawText,
        title,
        url: toAbsoluteUrl(href),
      });
    }

    match = pattern.exec(html);
  }

  return dedupeBy(items, (item) => item.url);
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

function parseReportItems(blocks, headingIndex) {
  const items = [];
  let index = headingIndex + 1;

  while (index < blocks.length) {
    const current = blocks[index];

    if (isReportStopBlock(current)) {
      break;
    }

    if (isReportNoiseBlock(current)) {
      index += 1;
      continue;
    }

    if (/^\d+$/.test(current)) {
      const rank = Number(current);
      let title = "";
      let source = "";
      let cursor = index + 1;

      while (cursor < blocks.length && isReportNoiseBlock(blocks[cursor])) {
        cursor += 1;
      }

      if (cursor < blocks.length && !isReportStopBlock(blocks[cursor]) && !/^\d+$/.test(blocks[cursor])) {
        title = truncate(blocks[cursor], 260);
        cursor += 1;
      }

      while (cursor < blocks.length && isReportNoiseBlock(blocks[cursor])) {
        cursor += 1;
      }

      if (
        cursor < blocks.length &&
        !isReportStopBlock(blocks[cursor]) &&
        !/^\d+$/.test(blocks[cursor]) &&
        blocks[cursor].length <= 60
      ) {
        source = blocks[cursor];
        cursor += 1;
      }

      if (title) {
        items.push({
          index: rank || items.length + 1,
          source,
          text: title,
        });
      }

      index = cursor;
      continue;
    }

    index += 1;
  }

  return items;
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

async function tryFetchCnReport(targetDate, logger) {
  const reportUrl = `${BASE_URL}report/detail?date=${targetDate}`;

  try {
    const html = await fetchText(reportUrl, logger);
    const blocks = extractTextBlocks(html);
    const headingIndex = findReportHeadingIndex(blocks, targetDate);

    if (headingIndex < 0) {
      return null;
    }

    const items = parseReportItems(blocks, headingIndex);
    if (items.length === 0) {
      return null;
    }

    return {
      heading: blocks[headingIndex],
      items,
      title: extractMetaContent(html, "og:title") || extractTitleTag(html) || `早报 / ${toCnReportLabel(targetDate)}`,
      url: reportUrl,
    };
  } catch (error) {
    logger.warn(`Failed to load Chinese report page for ${targetDate}: ${error.message}`);
    return null;
  }
}

function selectFallbackItems(homeHtml, targetDate, timeZone) {
  const today = getTodayIsoDate(timeZone);
  const exactDate = toCnCardDate(targetDate);
  const candidates = extractArticleLinks(homeHtml);
  const exactMatches = candidates.filter((item) => item.dateText === exactDate);

  if (exactMatches.length > 0) {
    return {
      items: exactMatches.slice(0, 8).map((item, index) => ({
        dateText: item.dateText,
        index: index + 1,
        title: item.title,
        url: item.url,
      })),
      matchStrategy: "homepage_exact_date",
    };
  }

  const latestItems = candidates.slice(0, 8).map((item, index) => ({
    dateText: item.dateText,
    index: index + 1,
    title: item.title,
    url: item.url,
  }));

  return {
    items: latestItems,
    matchStrategy: targetDate === today ? "homepage_latest_today" : "homepage_latest",
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

function buildReportMessage(keyword, targetDate, report) {
  const lines = [];

  if (keyword) {
    lines.push(keyword);
  }

  lines.push(`2Firsts 中文站早报 ${targetDate}`);
  lines.push("模式: report_detail");
  lines.push(`标题: ${report.title}`);

  report.items.slice(0, 8).forEach((item) => {
    lines.push(`${item.index}. ${item.text}${item.source ? ` [${item.source}]` : ""}`);
  });

  lines.push(`页面: ${report.url}`);
  return lines.join("\n");
}

function buildFallbackMessage(keyword, targetDate, items) {
  const lines = [];

  if (keyword) {
    lines.push(keyword);
  }

  lines.push(`2Firsts 中文站首页资讯 ${targetDate}`);
  lines.push("模式: fallback_news");

  items.forEach((item) => {
    lines.push(`${item.index}. ${item.title}`);
    lines.push(`   ${item.url}`);
  });

  return lines.join("\n");
}

async function sendToFeishu({ logger, secret, text, webhook }) {
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

  const payload = {
    content: { text },
    msg_type: "text",
  };

  if (secret) {
    Object.assign(payload, buildFeishuSignature(secret));
  }

  logger.info(`Sending Feishu message (textLength=${text.length}, signature=${secret ? "enabled" : "disabled"})`);

  try {
    const response = await fetch(url, {
      body: JSON.stringify(payload),
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

    const responseCode = parsed && typeof parsed === "object" ? (parsed.code ?? parsed.StatusCode ?? null) : null;
    const responseMessage = parsed && typeof parsed === "object" ? cleanEnv(parsed.msg || parsed.StatusMessage || "") : "";
    const success = response.ok && (responseCode === null || Number(responseCode) === 0 || responseMessage === "success");

    return {
      attempted: true,
      httpStatus: response.status,
      reason: success ? "Feishu message sent successfully." : `Feishu API returned HTTP ${response.status}${responseMessage ? ` (${responseMessage})` : ""}.`,
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
    `- matchStrategy: ${result.matchStrategy}`,
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
    "```text",
    result.messageText,
    "```",
    "",
  ];

  if (result.mode === "report_detail" && result.report) {
    lines.push("## Report Page");
    lines.push("");
    lines.push(`- title: ${result.report.title}`);
    lines.push(`- heading: ${result.report.heading}`);
    lines.push(`- url: ${result.report.url}`);
    lines.push("");
    lines.push("## Extracted Report Items");
    lines.push("");

    result.report.items.forEach((item) => {
      lines.push(`${item.index}. ${item.text}${item.source ? ` [${item.source}]` : ""}`);
    });
  } else {
    lines.push("## Extracted Homepage News");
    lines.push("");

    result.items.forEach((item) => {
      lines.push(`${item.index}. ${item.title}${item.dateText ? ` (${item.dateText})` : ""}`);
      lines.push(`   ${item.url}`);
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
  const previewOnly = envFlag("PREVIEW_ONLY", false);
  const feishuWebhook = cleanEnv(process.env.FEISHU_WEBHOOK);
  const feishuSecret = cleanEnv(process.env.FEISHU_SECRET);
  const feishuKeyword = cleanEnv(process.env.FEISHU_KEYWORD);
  const runStamp = getRunStamp();

  logger.info(`BASE_URL=${BASE_URL}`);
  logger.info(`TARGET_DATE=${targetDate}`);
  logger.info(`TARGET_DATE_TEXT=${targetDateText}`);
  logger.info(`PREVIEW_ONLY=${previewOnly}`);
  logger.info(`TIME_ZONE=${timeZone}`);
  logger.info(`FEISHU_WEBHOOK=${maskEnvPresence(feishuWebhook)}`);
  logger.info(`FEISHU_SECRET=${maskEnvPresence(feishuSecret)}`);
  logger.info(`FEISHU_KEYWORD=${maskEnvPresence(feishuKeyword)}`);

  const report = await tryFetchCnReport(targetDate, logger);

  let mode = "fallback_news";
  let matchStrategy = "homepage_latest";
  let items = [];

  if (report) {
    mode = "report_detail";
    matchStrategy = "report_detail_page";
    items = report.items.map((item) => ({
      index: item.index,
      source: item.source,
      text: item.text,
      type: "report_item",
    }));
    logger.info(`Chinese daily report found with ${report.items.length} items.`);
  } else {
    logger.warn(`No Chinese daily report found for ${targetDate}; falling back to homepage news.`);
    const homeHtml = await fetchText(BASE_URL, logger);
    const fallback = selectFallbackItems(homeHtml, targetDate, timeZone);
    items = fallback.items;
    matchStrategy = fallback.matchStrategy;
    logger.info(`Homepage fallback selected ${items.length} items.`);
  }

  const messageText =
    mode === "report_detail"
      ? buildReportMessage(feishuKeyword, targetDate, report)
      : buildFallbackMessage(feishuKeyword, targetDate, items);

  logger.info(`Prepared message preview (${messageText.length} chars).`);

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
      secret: feishuSecret,
      text: messageText,
      webhook: feishuWebhook,
    });
  }

  logger.info(`Send status=${send.status}`);
  logger.info(`Send reason=${send.reason}`);

  const diagnostics = [
    "This run now targets https://cn.2firsts.com/ instead of https://www.2firsts.com/.",
    "The script first tries the Chinese daily report page /report/detail?date=YYYY-MM-DD, then falls back to the Chinese homepage news list.",
    "This run always writes preview/latest.json, preview/latest.md, and preview/latest.log so you can see the exact extracted content even when Feishu send fails.",
    "If the bot uses signature verification, FEISHU_SECRET must be configured and passed by GitHub Actions.",
    "If the bot uses keyword security, FEISHU_KEYWORD is automatically prepended to the message when configured.",
  ];

  if (!previewOnly && !feishuWebhook) {
    diagnostics.push("FEISHU_WEBHOOK is missing, so extraction can succeed while sending still fails.");
  }

  if (!previewOnly && feishuWebhook && !feishuSecret) {
    diagnostics.push("If your Feishu bot requires signature verification, an empty FEISHU_SECRET can cause the webhook call to fail.");
  }

  const result = {
    baseUrl: BASE_URL,
    createdAt: new Date().toISOString(),
    diagnostics,
    env: {
      FEISHU_KEYWORD: maskEnvPresence(feishuKeyword),
      FEISHU_SECRET: maskEnvPresence(feishuSecret),
      FEISHU_WEBHOOK: maskEnvPresence(feishuWebhook),
      PREVIEW_ONLY: String(previewOnly),
      TARGET_DATE: targetDate,
      TIME_ZONE: timeZone,
    },
    itemCount: items.length,
    items,
    matchStrategy,
    messageText,
    mode,
    previewOnly,
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
    env: {
      FEISHU_KEYWORD: maskEnvPresence(process.env.FEISHU_KEYWORD),
      FEISHU_SECRET: maskEnvPresence(process.env.FEISHU_SECRET),
      FEISHU_WEBHOOK: maskEnvPresence(process.env.FEISHU_WEBHOOK),
      PREVIEW_ONLY: cleanEnv(process.env.PREVIEW_ONLY) || "false",
      TARGET_DATE: cleanEnv(process.env.TARGET_DATE) || "(auto)",
      TIME_ZONE: cleanEnv(process.env.TIME_ZONE) || "Asia/Shanghai",
    },
    itemCount: 0,
    items: [],
    matchStrategy: "none",
    messageText: "",
    mode: "failed",
    previewOnly: envFlag("PREVIEW_ONLY", false),
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
  };

  const markdown = buildMarkdown(result);
  finalizeArtifacts({ logger, markdown, result, runStamp });
  process.exitCode = 1;
});
