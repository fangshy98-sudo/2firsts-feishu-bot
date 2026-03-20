const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const crypto = require("crypto");
const { chromium } = require("playwright");

const HOME_URL = "https://cn.2firsts.com/";
const REPORT_URL_TEMPLATE = "https://cn.2firsts.com/report/detail?date={date}";
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK || "";
const FEISHU_SECRET = process.env.FEISHU_SECRET || "";
const FEISHU_KEYWORD = process.env.FEISHU_KEYWORD || "2F早报";
const PREVIEW_ONLY = process.env.PREVIEW_ONLY === "true";

const STOP_SECTION_RE = /^(查看更多|热门资讯|专题报道|特别报道|产品|快讯|厂商|合规|地区资讯|热门精选|相关推荐|精品原创)$/;
const SKIP_LINE_RE = /^(前一天|<前一天|选择日期|全部|回到今天)$/;

function nowInShanghai() {
  const now = new Date();
  const shanghai = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" })
  );

  const year = String(shanghai.getFullYear());
  const month = String(shanghai.getMonth() + 1).padStart(2, "0");
  const day = String(shanghai.getDate()).padStart(2, "0");

  return {
    dateText: `${year}-${month}-${day}`,
    monthDay: `${month}.${day}`,
    year,
    day
  };
}

function buildReportUrl(dateText) {
  return REPORT_URL_TEMPLATE.replace("{date}", dateText);
}

function cleanText(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

function cleanSourceName(text = "") {
  return cleanText(text).replace(/[，,;；。:：]+$/g, "").trim();
}

function absoluteUrl(url) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  return new URL(url, HOME_URL).href;
}

function uniqueByTitle(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = cleanText(item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

function buildSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", stringToSign).digest("base64");
}

function isExternalUrl(url) {
  try {
    const parsed = new URL(url, HOME_URL);
    return !parsed.hostname.includes("2firsts.com");
  } catch {
    return false;
  }
}

function extractObservedReportDate(text) {
  const normalized = text.replace(/\r/g, "");
  const match = normalized.match(/早报\s*\/\s*(\d{2}\.\d{2})\s*\n?\s*(\d{4})/);
  return match ? `${match[1]} ${match[2]}` : "";
}

function looksLikeTargetReport(text, dateInfo) {
  return text.includes("早报") && text.includes(dateInfo.monthDay) && text.includes(dateInfo.year);
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status}`);
  }

  return await res.text();
}

async function readCalendarState(page) {
  return page.evaluate(() => {
    const header = document.querySelector(".calendar .header")?.textContent?.replace(/\s+/g, " ").trim() || "";
    const choose = document.querySelector(".calendar .li.choose");
    const today = document.querySelector(".calendar .li.today");

    return {
      header,
      chooseText: choose?.textContent?.trim() || "",
      chooseClass: choose?.className || "",
      todayText: today?.textContent?.trim() || "",
      todayClass: today?.className || ""
    };
  });
}

function calendarHasTodayReport(calendarState, dateInfo) {
  const dayNumber = String(Number(dateInfo.day));

  const chooseMatches =
    calendarState.chooseText === dayNumber &&
    calendarState.chooseClass &&
    !calendarState.chooseClass.includes("other");

  const todayMatches =
    calendarState.todayText === dayNumber &&
    calendarState.todayClass &&
    !calendarState.todayClass.includes("other");

  return chooseMatches || todayMatches;
}

async function forceLoadTodayReport(page, dateInfo) {
  const backToToday = page.locator(".calendar .header i", { hasText: "回到今天" });
  if (await backToToday.count()) {
    await backToToday.first().click({ force: true }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  const todayCell = page.locator(".calendar .li.today").first();
  if (await todayCell.count()) {
    await todayCell.click({ force: true }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  await page.waitForFunction(
    ({ monthDay, year }) => {
      const text = document.body?.innerText || "";
      return text.includes("早报") && text.includes(monthDay) && text.includes(year);
    },
    { monthDay: dateInfo.monthDay, year: dateInfo.year },
    { timeout: 8000 }
  ).catch(() => {});
}

async function fetchRenderedReportPage(url, dateInfo) {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0"
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    let calendarState = await readCalendarState(page);
    let text = await page.locator("body").innerText().catch(() => "");

    if (!looksLikeTargetReport(text, dateInfo) && calendarHasTodayReport(calendarState, dateInfo)) {
      await forceLoadTodayReport(page, dateInfo);
      calendarState = await readCalendarState(page);
      text = await page.locator("body").innerText().catch(() => "");
    }

    const html = await page.content();

    return {
      html,
      text,
      calendarState
    };
  } finally {
    await browser.close();
  }
}

function buildSourceMap($) {
  const sourceMap = new Map();

  $("a[href]").each((_, el) => {
    const href = absoluteUrl($(el).attr("href"));
    const text = cleanSourceName($(el).text());

    if (!href || !text) return;
    if (!isExternalUrl(href)) return;
    if (text.length > 80) return;
    if (SKIP_LINE_RE.test(text)) return;

    if (!sourceMap.has(text)) {
      sourceMap.set(text, href);
    }
  });

  return sourceMap;
}

function looksLikeSourceLine(line) {
  if (!line) return false;
  if (line.length > 40) return false;
  if (/[。；;:：]/.test(line)) return false;
  if (/^\d{2}-\d{2}$/.test(line)) return false;
  if (/^\d+天前$/.test(line)) return false;
  if (/^\d+小时前$/.test(line)) return false;
  if (STOP_SECTION_RE.test(line)) return false;
  if (SKIP_LINE_RE.test(line)) return false;
  return true;
}

function extractDailyReportFromDetail(renderedText, html, dateInfo, reportUrl) {
  if (!looksLikeTargetReport(renderedText, dateInfo)) {
    return [];
  }

  const normalizedText = renderedText.replace(/\r/g, "");
  const lines = normalizedText
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean);

  const headerIndex = lines.findIndex((line, idx) => {
    const nearby = lines.slice(idx, idx + 5).join(" ");
    return line.includes("早报") && nearby.includes(dateInfo.monthDay) && nearby.includes(dateInfo.year);
  });

  if (headerIndex === -1) {
    return [];
  }

  const $ = cheerio.load(html);
  const sourceMap = buildSourceMap($);

  const items = [];
  let current = null;
  let expectedNumber = 1;

  function pushCurrent() {
    if (!current) return;

    const title = cleanText(current.titleParts.join(" "));
    if (title.length >= 20) {
      items.push({
        title,
        sourceName: current.sourceName || "链接",
        sourceUrl: current.sourceUrl || reportUrl,
        url: reportUrl
      });
    }

    current = null;
  }

  function completeCurrentWithSource(name) {
    if (!current) return;
    current.sourceName = name || "链接";
    current.sourceUrl = sourceMap.get(name) || reportUrl;
    pushCurrent();
    expectedNumber += 1;
  }

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    if (!line) continue;
    if (line === dateInfo.year || line === dateInfo.monthDay) continue;
    if (SKIP_LINE_RE.test(line)) continue;

    if (STOP_SECTION_RE.test(line)) {
      pushCurrent();
      break;
    }

    const pureNumber = line.match(/^(\d{1,2})$/);
    const inlineNumber = line.match(/^(\d{1,2})\s*(.*)$/);

    if (!current) {
      if (pureNumber && Number(pureNumber[1]) === expectedNumber) {
        current = {
          titleParts: [],
          sourceName: "",
          sourceUrl: ""
        };
        continue;
      }

      if (inlineNumber && Number(inlineNumber[1]) === expectedNumber) {
        current = {
          titleParts: [],
          sourceName: "",
          sourceUrl: ""
        };

        const rest = cleanText(inlineNumber[2]);
        if (rest) {
          current.titleParts.push(rest);
        }
        continue;
      }

      if (items.length > 0) {
        break;
      }

      continue;
    }

    if (pureNumber && Number(pureNumber[1]) === expectedNumber + 1) {
      pushCurrent();
      expectedNumber += 1;
      current = {
        titleParts: [],
        sourceName: "",
        sourceUrl: ""
      };
      continue;
    }

    if (inlineNumber && Number(inlineNumber[1]) === expectedNumber + 1) {
      pushCurrent();
      expectedNumber += 1;
      current = {
        titleParts: [],
        sourceName: "",
        sourceUrl: ""
      };

      const rest = cleanText(inlineNumber[2]);
      if (rest) {
        current.titleParts.push(rest);
      }
      continue;
    }

    const normalizedSource = cleanSourceName(line);

    if (sourceMap.has(normalizedSource)) {
      completeCurrentWithSource(normalizedSource);
      if (items.length >= 10) break;
      continue;
    }

    if (looksLikeSourceLine(normalizedSource) && current.titleParts.length > 0) {
      completeCurrentWithSource(normalizedSource);
      if (items.length >= 10) break;
      continue;
    }

    current.titleParts.push(line);
  }

  pushCurrent();

  return uniqueByTitle(items).slice(0, 10);
}

function extractFallbackNews($) {
  const items = [];

  $("a[href]").each((_, el) => {
    const href = absoluteUrl($(el).attr("href"));
    const raw = cleanText($(el).text());

    if (!href.includes("/news/")) return;
    if (!raw) return;

    const match = raw.match(/^(.*?)(\s+)(\d+小时前|1天前|2天前)(\s+全球|\s+中国|\s+国际)?$/);

    if (!match) return;

    const title = cleanText(match[1]);
    const timeTag = match[3];

    if (timeTag === "2天前") return;

    items.push({
      title,
      url: href
    });
  });

  return uniqueByTitle(items).slice(0, 10);
}

function buildMessage({ dateText, mode, items }) {
  const modeText = mode === "daily_report" ? "早报" : "近期热点";

  const content = [
    [{ tag: "text", text: `模式：${modeText}` }],
    [{ tag: "text", text: "" }]
  ];

  items.forEach((item, index) => {
    const linkText =
      mode === "daily_report"
        ? (item.sourceName || "链接")
        : "链接";

    const linkHref =
      mode === "daily_report"
        ? (item.sourceUrl || item.url || HOME_URL)
        : (item.url || HOME_URL);

    content.push([
      { tag: "text", text: `${index + 1}. ${item.title} ` },
      { tag: "a", text: linkText, href: linkHref }
    ]);
  });

  content.push([
    { tag: "text", text: "来源：" },
    { tag: "a", text: "2Firsts", href: HOME_URL }
  ]);

  return {
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title: `${FEISHU_KEYWORD}｜${dateText}`,
          content
        }
      }
    }
  };
}

async function sendToFeishu(payload) {
  if (!FEISHU_WEBHOOK) {
    throw new Error("Missing FEISHU_WEBHOOK");
  }

  if (FEISHU_SECRET) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = buildSign(FEISHU_SECRET, timestamp);
  }

  const res = await fetch(FEISHU_WEBHOOK, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();

  if (data.code !== 0) {
    throw new Error(`Feishu send failed: ${JSON.stringify(data)}`);
  }

  return data;
}

function buildPreviewData({ dateText, mode, items, reportUrl, debug }) {
  return {
    generatedAt: new Date().toISOString(),
    previewOnly: PREVIEW_ONLY,
    date: dateText,
    mode,
    strategy: mode === "daily_report" ? "report_detail" : "homepage_fallback",
    count: items.length,
    reportUrl,
    items,
    debug
  };
}

function writePreviewFiles(preview) {
  const previewDir = path.join(process.cwd(), "preview");
  fs.mkdirSync(previewDir, { recursive: true });

  fs.writeFileSync(
    path.join(previewDir, "latest.json"),
    JSON.stringify(preview, null, 2),
    "utf8"
  );

  const modeText = preview.mode === "daily_report" ? "早报" : "近期热点";
  const lines = [
    `# ${FEISHU_KEYWORD}｜${preview.date}`,
    "",
    `- 模式：${modeText}`,
    `- 策略：${preview.strategy}`,
    `- 条数：${preview.count}`,
    `- 早报链接：${preview.reportUrl}`,
    `- 预览模式：${preview.previewOnly ? "是" : "否"}`,
    "",
    "## 内容"
  ];

  preview.items.forEach((item, index) => {
    const linkText =
      preview.mode === "daily_report"
        ? (item.sourceName || "链接")
        : "链接";

    const linkHref =
      preview.mode === "daily_report"
        ? (item.sourceUrl || item.url || HOME_URL)
        : (item.url || HOME_URL);

    lines.push(`${index + 1}. ${item.title}`);
    lines.push(`   ${linkText}: ${linkHref}`);
  });

  lines.push("");
  lines.push("## Debug");
  lines.push(`- reportItemCount: ${preview.debug.reportItemCount}`);
  lines.push(`- fallbackItemCount: ${preview.debug.fallbackItemCount}`);
  lines.push(`- reportError: ${preview.debug.reportError || ""}`);
  lines.push(`- fallbackError: ${preview.debug.fallbackError || ""}`);
  lines.push(`- observedReportDate: ${preview.debug.observedReportDate || ""}`);
  lines.push(`- calendarHeader: ${preview.debug.calendarHeader || ""}`);
  lines.push(`- calendarChooseText: ${preview.debug.calendarChooseText || ""}`);
  lines.push(`- calendarChooseClass: ${preview.debug.calendarChooseClass || ""}`);
  lines.push(`- calendarTodayText: ${preview.debug.calendarTodayText || ""}`);
  lines.push(`- calendarTodayClass: ${preview.debug.calendarTodayClass || ""}`);
  lines.push("");
  lines.push("## Report Text Sample");
  lines.push("```text");
  lines.push(preview.debug.reportTextSample || "");
  lines.push("```");

  const markdown = lines.join("\n");

  fs.writeFileSync(
    path.join(previewDir, "latest.md"),
    markdown,
    "utf8"
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  }
}

async function main() {
  const dateInfo = nowInShanghai();
  const reportUrl = buildReportUrl(dateInfo.dateText);

  let items = [];
  let mode = "daily_report";
  let reportItems = [];
  let fallbackItems = [];
  let reportError = "";
  let fallbackError = "";
  let reportTextSample = "";
  let observedReportDate = "";
  let calendarHeader = "";
  let calendarChooseText = "";
  let calendarChooseClass = "";
  let calendarTodayText = "";
  let calendarTodayClass = "";

  try {
    const rendered = await fetchRenderedReportPage(reportUrl, dateInfo);
    reportTextSample = rendered.text.slice(0, 3000);
    observedReportDate = extractObservedReportDate(rendered.text);

    calendarHeader = rendered.calendarState.header || "";
    calendarChooseText = rendered.calendarState.chooseText || "";
    calendarChooseClass = rendered.calendarState.chooseClass || "";
    calendarTodayText = rendered.calendarState.todayText || "";
    calendarTodayClass = rendered.calendarState.todayClass || "";

    reportItems = extractDailyReportFromDetail(
      rendered.text,
      rendered.html,
      dateInfo,
      reportUrl
    );
    items = reportItems;
  } catch (err) {
    reportError = err.message || String(err);
    items = [];
  }

  if (!items.length) {
    try {
      const homeHtml = await fetchHtml(HOME_URL);
      const $home = cheerio.load(homeHtml);
      fallbackItems = extractFallbackNews($home);
      items = fallbackItems;
      mode = "fallback_news";
    } catch (err) {
      fallbackError = err.message || String(err);
    }
  }

  const preview = buildPreviewData({
    dateText: dateInfo.dateText,
    mode,
    items,
    reportUrl,
    debug: {
      reportItemCount: reportItems.length,
      fallbackItemCount: fallbackItems.length,
      reportError,
      fallbackError,
      observedReportDate,
      calendarHeader,
      calendarChooseText,
      calendarChooseClass,
      calendarTodayText,
      calendarTodayClass,
      reportTextSample
    }
  });

  writePreviewFiles(preview);

  if (!items.length) {
    console.log("No news extracted, skip sending");
    return;
  }

  if (PREVIEW_ONLY) {
    console.log("Preview only, skip sending to Feishu");
    return;
  }

  const payload = buildMessage({
    dateText: dateInfo.dateText,
    mode,
    items
  });

  await sendToFeishu(payload);

  console.log(
    JSON.stringify(
      {
        ok: true,
        dateText: dateInfo.dateText,
        mode,
        count: items.length
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
