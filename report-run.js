const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const BASE_URL = "https://cn.2firsts.com/";
const PREVIEW_DIR = path.join(__dirname, "preview");
const RUNS_DIR = path.join(PREVIEW_DIR, "runs");
const REPORT_EMPTY_MESSAGE = "当日早报页面暂无可解析条目";
const HTML_ENTITIES = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };

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
  info(message) { this.write("INFO", message); }
  warn(message) { this.write("WARN", message); }
  error(message) { this.write("ERROR", message); }
  toString() { return `${this.lines.join("\n")}\n`; }
}

function ensureDir(dirPath) { fs.mkdirSync(dirPath, { recursive: true }); }
function writeUtf8(filePath, content) { fs.writeFileSync(filePath, content, { encoding: "utf8" }); }
function writeJson(filePath, value) { writeUtf8(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function cleanEnv(value) { return typeof value === "string" ? value.trim() : ""; }
function collapseWhitespace(text) { return text.replace(/\s+/g, " ").trim(); }
function truncate(text, maxLength) { return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`; }
function envFlag(name, defaultValue = false) { const raw = cleanEnv(process.env[name]); return raw ? /^(1|true|yes|on)$/i.test(raw) : defaultValue; }
function maskEnvPresence(value) { return cleanEnv(value) ? "present" : "missing"; }
function buildHeaderName(keyword) { return cleanEnv(keyword) || "2F早报"; }
function getTodayIsoDate(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", year: "numeric", timeZone }).formatToParts(new Date());
  const map = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day}`;
}
function normalizeTargetDate(value, timeZone) {
  const normalized = cleanEnv(value) || getTodayIsoDate(timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error(`TARGET_DATE must be YYYY-MM-DD, received "${normalized || "(empty)"}".`);
  return normalized;
}
function decodeHtmlEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith("#")) {
      const isHex = entity[1].toLowerCase() === "x";
      const numeric = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isNaN(numeric)) {
        try { return String.fromCodePoint(numeric); } catch { return match; }
      }
      return match;
    }
    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, entity) ? HTML_ENTITIES[entity] : match;
  });
}
function stripTags(html) {
  return collapseWhitespace(decodeHtmlEntities(html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")).replace(/\u00a0/g, " "));
}
function extractMetaContent(html, key) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=(["'])([\\s\\S]*?)\\1[^>]*>`, "i");
  const match = html.match(pattern);
  return match ? stripTags(match[2]) : "";
}
function extractTitleTag(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1]) : "";
}
function extractNuxtState(html) {
  const match = html.match(/<script>window\.__NUXT__=([\s\S]*?)<\/script>/) || html.match(/<script>__NUXT__=([\s\S]*?)<\/script>/);
  if (!match) return null;
  const source = match[0].replace(/^<script>/, "").replace(/<\/script>$/, "");
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context, { timeout: 5000 });
  return context.window.__NUXT__ || context.__NUXT__ || null;
}
function toAbsoluteUrl(value) { return new URL(decodeHtmlEntities(value), BASE_URL).href; }
function normalizeOptionalUrl(value) { const raw = cleanEnv(value); if (!raw) return ""; try { return toAbsoluteUrl(raw); } catch { return ""; } }
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  const raw = cleanEnv(value);
  if (!raw) return [];
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function parseReportItems(report) {
  return parseJsonArray(report?.content).map((item, index) => {
    const text = truncate(collapseWhitespace(cleanEnv(item?.title || item?.text || "")), 260);
    if (!text) return null;
    return { index: index + 1, source: collapseWhitespace(cleanEnv(item?.source || "")), text, url: normalizeOptionalUrl(item?.link || item?.url) };
  }).filter(Boolean).slice(0, 8);
}
function buildReportUrl(report, targetDate) { const seoUrl = cleanEnv(report?.seo_url); return seoUrl ? new URL(`report/${seoUrl}`, BASE_URL).href : `${BASE_URL}report/detail?date=${targetDate}`; }
function resolveWebhookUrl(rawWebhook) { if (!rawWebhook) return ""; return /^https?:\/\//i.test(rawWebhook) ? rawWebhook : `https://open.feishu.cn/open-apis/bot/v2/hook/${rawWebhook}`; }
function buildFeishuSignature(secret) { const timestamp = String(Math.floor(Date.now() / 1000)); const key = `${timestamp}\n${secret}`; return { sign: crypto.createHmac("sha256", key).update("").digest("base64"), timestamp }; }
async function fetchText(url, logger) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    logger.info(`Fetching ${url}`);
    const response = await fetch(url, { headers: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36" }, redirect: "follow", signal: controller.signal });
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (!response.ok) throw new Error(`Request failed with HTTP ${response.status} for ${url}`);
    return text;
  } finally { clearTimeout(timeout); }
}
async function tryFetchReport(targetDate, logger) {
  const reportUrl = `${BASE_URL}report/detail?date=${targetDate}`;
  try {
    const html = await fetchText(reportUrl, logger);
    const nuxt = extractNuxtState(html);
    const report = nuxt?.data?.[0]?.report || null;
    const items = parseReportItems(report);
    if (!items.length) return null;
    return { title: cleanEnv(report?.title) || extractMetaContent(html, "og:title") || extractTitleTag(html) || `早报 / ${targetDate}`, url: buildReportUrl(report, targetDate), items };
  } catch (error) {
    logger.warn(`Failed to load Chinese report page for ${targetDate}: ${error.message}`);
    return null;
  }
}
function buildFeishuPostPayload(headerName, targetDate, items, reportUrl) {
  const content = [[{ tag: "text", text: `｜${targetDate}` }], [{ tag: "text", text: "模式：早报" }]];
  if (!items.length) content.push([{ tag: "text", text: REPORT_EMPTY_MESSAGE }]);
  items.forEach((item) => {
    const row = [{ tag: "text", text: `${item.index}. ${item.text}${item.source ? ` - ${item.source}` : ""}${item.url ? " - " : ""}` }];
    if (item.url) row.push({ tag: "a", text: "查看原文", href: item.url });
    content.push(row);
  });
  if (reportUrl) content.push([{ tag: "text", text: "早报页面：" }, { tag: "a", text: "查看早报", href: reportUrl }]);
  return { content: { post: { zh_cn: { content, title: headerName } } }, msg_type: "post" };
}
async function sendToFeishu({ logger, payload, secret, webhook }) {
  const url = resolveWebhookUrl(webhook);
  if (!url) return { attempted: false, reason: "FEISHU_WEBHOOK is missing, so no message could be sent.", responseBody: "", responseCode: null, responseMessage: "", status: "failed", success: false };
  const finalPayload = { ...payload };
  if (secret) Object.assign(finalPayload, buildFeishuSignature(secret));
  logger.info(`Sending Feishu ${finalPayload.msg_type} message (rows=${finalPayload.content?.post?.zh_cn?.content?.length || 0}, signature=${secret ? "enabled" : "disabled"})`);
  try {
    const response = await fetch(url, { body: JSON.stringify(finalPayload), headers: { "content-type": "application/json" }, method: "POST" });
    const body = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    const responseCode = parsed && typeof parsed === "object" ? parsed.code ?? parsed.StatusCode ?? null : null;
    const responseMessage = parsed && typeof parsed === "object" ? cleanEnv(parsed.msg || parsed.StatusMessage || "") : "";
    const success = response.ok && (responseCode === null || Number(responseCode) === 0 || responseMessage === "success");
    return { attempted: true, httpStatus: response.status, reason: success ? "Feishu message sent successfully." : `Feishu API returned HTTP ${response.status}${responseMessage ? ` (${responseMessage})` : ""}.`, responseBody: truncate(body || "", 2000), responseCode, responseMessage, status: success ? "sent" : "failed", success };
  } catch (error) {
    return { attempted: true, reason: `Failed to call Feishu webhook: ${error.message}`, responseBody: "", responseCode: null, responseMessage: "", status: "failed", success: false };
  }
}
function buildMarkdown(result) {
  const lines = ["# 2Firsts CN Daily Run", "", `- targetDate: ${result.targetDate}`, `- baseUrl: ${result.baseUrl}`, `- mode: ${result.mode}`, `- displayMode: ${result.displayMode}`, `- contentSource: ${result.contentSource}`, `- itemCount: ${result.itemCount}`, `- previewOnly: ${result.previewOnly}`, `- status: ${result.status}`, `- sendStatus: ${result.send.status}`, `- sendReason: ${result.send.reason}`, `- webhook: ${result.env.FEISHU_WEBHOOK}`, `- secret: ${result.env.FEISHU_SECRET}`, `- keyword: ${result.env.FEISHU_KEYWORD}`, "", "## Message Preview", "", result.messageMarkdown, "## Extracted Report Items", ""];
  if (!result.items.length) lines.push(REPORT_EMPTY_MESSAGE);
  result.items.forEach((item) => lines.push(`${item.index}. ${item.text}${item.source ? ` - ${item.source}` : ""}${item.url ? ` - [查看原文](${item.url})` : ""}`));
  if (result.report?.url) { lines.push(""); lines.push(`早报页面：[查看早报](${result.report.url})`); }
  lines.push("");
  lines.push("## Diagnostics");
  lines.push("");
  result.diagnostics.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  lines.push("");
  return `${lines.join("\n")}\n`;
}
function finalizeArtifacts({ logger, markdown, result, runStamp }) {
  ensureDir(PREVIEW_DIR); ensureDir(RUNS_DIR);
  const runBaseName = `run-${runStamp}`;
  writeJson(path.join(RUNS_DIR, `${runBaseName}.json`), result);
  writeUtf8(path.join(RUNS_DIR, `${runBaseName}.md`), markdown);
  writeUtf8(path.join(RUNS_DIR, `${runBaseName}.log`), logger.toString());
  writeJson(path.join(PREVIEW_DIR, "latest.json"), result);
  writeUtf8(path.join(PREVIEW_DIR, "latest.md"), markdown);
  writeUtf8(path.join(PREVIEW_DIR, "latest.log"), logger.toString());
  logger.info(`Artifacts written to ${PREVIEW_DIR}`);
}
function patchFallbackArtifactContentSource() {
  const latestJsonPath = path.join(PREVIEW_DIR, "latest.json");
  if (!fs.existsSync(latestJsonPath)) return;
  const latest = JSON.parse(fs.readFileSync(latestJsonPath, "utf8"));
  if (!latest.contentSource) {
    latest.contentSource = "latest_48h";
    writeJson(latestJsonPath, latest);
  }
}
async function run() {
  ensureDir(PREVIEW_DIR); ensureDir(RUNS_DIR);
  const logger = new RunLogger();
  const timeZone = cleanEnv(process.env.TIME_ZONE) || "Asia/Shanghai";
  const targetDate = normalizeTargetDate(process.env.TARGET_DATE, timeZone);
  const previewOnly = envFlag("PREVIEW_ONLY", false);
  const feishuWebhook = cleanEnv(process.env.FEISHU_WEBHOOK);
  const feishuSecret = cleanEnv(process.env.FEISHU_SECRET);
  const feishuKeyword = cleanEnv(process.env.FEISHU_KEYWORD);
  logger.info(`TARGET_DATE=${targetDate}`);
  logger.info(`PREVIEW_ONLY=${previewOnly}`);
  logger.info(`TIME_ZONE=${timeZone}`);
  logger.info(`FEISHU_WEBHOOK=${maskEnvPresence(feishuWebhook)}`);
  logger.info(`FEISHU_SECRET=${maskEnvPresence(feishuSecret)}`);
  logger.info(`FEISHU_KEYWORD=${maskEnvPresence(feishuKeyword)}`);
  const report = await tryFetchReport(targetDate, logger);
  if (!report) {
    logger.info("REPORT_MODE=fallback_to_index_js");
    const child = spawnSync(process.execPath, [path.join(__dirname, "index.js")], { cwd: __dirname, env: process.env, stdio: "inherit" });
    patchFallbackArtifactContentSource();
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }
  const headerName = buildHeaderName(feishuKeyword);
  let messageMarkdown = `${headerName}\n｜${targetDate}\n模式：早报\n\n`;
  messageMarkdown += report.items.length ? report.items.map((item) => `${item.index}. ${item.text}${item.source ? ` - ${item.source}` : ""}${item.url ? ` - [查看原文](${item.url})` : ""}`).join("\n") : REPORT_EMPTY_MESSAGE;
  if (report.url) messageMarkdown += `\n\n早报页面：[查看早报](${report.url})\n`;
  const payload = buildFeishuPostPayload(headerName, targetDate, report.items, report.url);
  let send = { attempted: false, reason: "PREVIEW_ONLY=true, message was not sent.", responseBody: "", responseCode: null, responseMessage: "", status: "skipped", success: false };
  if (!previewOnly) send = await sendToFeishu({ logger, payload, secret: feishuSecret, webhook: feishuWebhook });
  logger.info(`Send status=${send.status}`);
  logger.info(`Send reason=${send.reason}`);
  const result = {
    baseUrl: BASE_URL,
    contentSource: "report_detail",
    createdAt: new Date().toISOString(),
    diagnostics: [
      "The dated report page was available, so this run used the report page's structured items directly instead of the latest 48-hour homepage pool.",
      "Each morning-report row keeps the report page order, summary text, source, and direct article link when 2Firsts exposes one.",
      "The report page link is appended at the end of the message and the preview artifacts record contentSource=report_detail for faster debugging.",
    ],
    displayMode: "早报",
    env: {
      FEISHU_KEYWORD: maskEnvPresence(feishuKeyword),
      FEISHU_SECRET: maskEnvPresence(feishuSecret),
      FEISHU_WEBHOOK: maskEnvPresence(feishuWebhook),
      PREVIEW_ONLY: String(previewOnly),
      TARGET_DATE: targetDate,
      TIME_ZONE: timeZone,
    },
    feishuPayload: payload,
    headerName,
    itemCount: report.items.length,
    items: report.items,
    matchStrategy: "report_detail",
    messageMarkdown,
    messageText: `${headerName}\n｜${targetDate}\n模式：早报`,
    mode: "morning_report",
    previewOnly,
    report,
    send,
    status: previewOnly || send.status === "sent" ? "success" : send.status === "skipped" ? "warning" : "failed",
    targetDate,
    targetDateText: targetDate,
  };
  const markdown = buildMarkdown(result);
  finalizeArtifacts({ logger, markdown, result, runStamp: new Date().toISOString().replace(/[:.]/g, "-") });
  if (!previewOnly && !send.success) process.exitCode = 1;
}
run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
