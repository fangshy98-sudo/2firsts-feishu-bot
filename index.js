const cheerio = require("cheerio");
const crypto = require("crypto");
const { chromium } = require("playwright");

const HOME_URL = "https://cn.2firsts.com/";
const REPORT_URL_TEMPLATE = "https://cn.2firsts.com/report/detail?date={date}";
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK || "";
const FEISHU_SECRET = process.env.FEISHU_SECRET || "";
const FEISHU_KEYWORD = process.env.FEISHU_KEYWORD || "2F早报";

const STOP_SECTION_RE = /^(查看更多|热门资讯|专题报道|特别报道|产品|快讯|厂商|合规|地区资讯)$/;
const SKIP_LINE_RE = /^(前一天|<前一天|选择日期|全部)$/;

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
    year
  };
}

function buildReportUrl(dateText) {
  return REPORT_URL_TEMPLATE.replace("{date}", dateText);
}

function cleanText(text = "") {
  return text.replace(/\s+/g, " ").trim();
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

async function fetchRenderedReportPage(url) {
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

    const html = await page.content();
    const text = await page.locator("body").innerText().catch(() => "");

    return { html, text };
  } finally {
    await browser.close();
  }
}

function buildSourceMap($) {
  const sourceMap = new Map();

  $("a[href]").each((_, el) => {
    const href = absoluteUrl($(el).attr("href"));
    const text = cleanText($(el).text());

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

function splitTailSource(text, sourceNames) {
  const cleaned = cleanText(text);

  for (const sourceName of sourceNames) {
    if (cleaned === sourceName) {
      return { title: "", sourceName };
    }

    if (cleaned.endsWith(` ${sourceName}`)) {
      return {
        title: cleanText(cleaned.slice(0, -sourceName.length)),
        sourceName
      };
    }
  }

  return {
    title: cleaned,
    sourceName: ""
  };
}

function extractDailyReportFromDetail(renderedText, html, dateInfo) {
  const normalizedText = renderedText.replace(/\r/g, "");
  const lines = normalizedText
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean);

  const headerIndex = lines.findIndex((line, idx) => {
    const nearby = lines.slice(idx, idx + 4).join(" ");
    return line.includes("早报") && line.includes(dateInfo.monthDay) && nearby.includes(dateInfo.year);
  });

  if (headerIndex === -1) {
    return [];
  }

  const $ = cheerio.load(html);
  const sourceMap = buildSourceMap($);
  const sourceNames = Array.from(sourceMap.keys()).sort((a, b) => b.length - a.length);

  const items = [];
  let current = null;

  function pushCurrent() {
    if (!current) return;

    const title = cleanText(current.titleParts.join(" "));
    if (title.length >= 20) {
      items.push({
        title,
        sourceName: current.sourceName || "链接",
        sourceUrl: current.sourceUrl || ""
      });
    }

    current = null;
  }

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    if (!line) continue;
    if (STOP_SECTION_RE.test(line)) break;
    if (SKIP_LINE_RE.test(line)) continue;
    if (line === dateInfo.year || line === dateInfo.monthDay) continue;

    const numbered = line.match(/^(\d{1,2})\s*(.*)$/);

    if (numbered) {
      pushCurrent();

      current = {
        titleParts: [],
        sourceName: "",
        sourceUrl: ""
      };

      const rest = cleanText(numbered[2]);
      if (rest) {
        const parsed = splitTailSource(rest, sourceNames);
        if (parsed.title) {
          current.titleParts.push(parsed.title);
        }
        if (parsed.sourceName) {
          current.sourceName = parsed.sourceName;
          current.sourceUrl = sourceMap.get(parsed.sourceName) || "";
          pushCurrent();
        }
      }

      continue;
    }

    if (!current) {
      continue;
    }

    if (!current.sourceName && sourceMap.has(line)) {
      current.sourceName = line;
      current.sourceUrl = sourceMap.get(line) || "";
      pushCurrent();
      continue;
    }

    const parsed = splitTailSource(line, sourceNames);
    if (parsed.title) {
      current.titleParts.push(parsed.title);
    }

    if (!current.sourceName && parsed.sourceName) {
      current.sourceName = parsed.sourceName;
      current.sourceUrl = sourceMap.get(parsed.sourceName) || "";
      pushCurrent();
    }
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
      mode === "daily_report" ? (item.sourceName || "链接") : "链接";

    const linkHref =
      mode === "daily_report"
        ? (item.sourceUrl || HOME_URL)
        : item.url;

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

async function main() {
  const dateInfo = nowInShanghai();

  let items = [];
  let mode = "daily_report";

  // 1. 先抓当天动态早报详情页
  try {
    const reportUrl = buildReportUrl(dateInfo.dateText);
    const rendered = await fetchRenderedReportPage(reportUrl);
    items = extractDailyReportFromDetail(rendered.text, rendered.html, dateInfo);
  } catch (err) {
    items = [];
  }

  // 2. 如果当天没有早报，再回退首页 48 小时内热点
  if (!items.length) {
    const homeHtml = await fetchHtml(HOME_URL);
    const $home = cheerio.load(homeHtml);
    items = extractFallbackNews($home);
    mode = "fallback_news";
  }

  // 3. 没有内容则静默不发群
  if (!items.length) {
    console.log("No news extracted, skip sending");
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
