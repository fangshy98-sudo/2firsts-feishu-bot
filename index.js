const cheerio = require("cheerio");
const crypto = require("crypto");

const HOME_URL = "https://cn.2firsts.com/";
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK || "";
const FEISHU_SECRET = process.env.FEISHU_SECRET || "";
const FEISHU_KEYWORD = process.env.FEISHU_KEYWORD || "2F早报";

function nowInShanghai() {
  const now = new Date();
  const shanghai = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" })
  );

  const year = shanghai.getFullYear();
  const month = String(shanghai.getMonth() + 1).padStart(2, "0");
  const day = String(shanghai.getDate()).padStart(2, "0");

  return {
    dateText: `${year}-${month}-${day}`,
    reportMarker: `${month}.${day} ${year}`
  };
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

function extractDailyReport($, marker) {
  const target = `早报 / ${marker}`;
  const allNodes = $("body *").toArray();
  const startIndex = allNodes.findIndex((el) => cleanText($(el).text()) === target);

  if (startIndex === -1) return [];

  const items = [];

  for (let i = startIndex + 1; i < allNodes.length; i++) {
    const node = allNodes[i];
    const text = cleanText($(node).text());

    if (!text) continue;

    if (/^(查看更多|热门资讯|专题报道|特别报道|产品|快讯|厂商|合规)$/.test(text)) {
      break;
    }

    const links = $(node).find("a[href]").toArray();

    for (const link of links) {
      const href = absoluteUrl($(link).attr("href"));
      const title = cleanText($(link).text());

      if (!href.includes("/news/")) continue;
      if (!title) continue;
      if (title === "全部") continue;

      items.push({
        title,
        url: href
      });
    }

    if (items.length >= 12) break;
  }

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
      timeTag,
      url: href
    });
  });

  return uniqueByTitle(items).slice(0, 10);
}

function buildMessage({ dateText, mode, items }) {
  const title = mode === "daily_report" ? "今日早报" : "首页近48小时新闻";
  const lines = [
    `${FEISHU_KEYWORD}｜${dateText}`,
    `模式：${title}`,
    ""
  ];

  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`);
    if (item.timeTag) {
      lines.push(`时间：${item.timeTag}`);
    }
    lines.push(`链接：${item.url}`);
    lines.push("");
  });

  lines.push(`来源：${HOME_URL}`);
  return lines.join("\n");
}

async function sendToFeishu(text) {
  if (!FEISHU_WEBHOOK) {
    throw new Error("Missing FEISHU_WEBHOOK");
  }

  const payload = {
    msg_type: "text",
    content: {
      text
    }
  };

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
  const { dateText, reportMarker } = nowInShanghai();
  const html = await fetchHtml(HOME_URL);
  const $ = cheerio.load(html);

  let items = extractDailyReport($, reportMarker);
  let mode = "daily_report";

  if (!items.length) {
    items = extractFallbackNews($);
    mode = "fallback_news";
  }

  if (!items.length) {
    throw new Error("No news extracted from homepage");
  }

  const message = buildMessage({
    dateText,
    mode,
    items
  });

  await sendToFeishu(message);

  console.log(
    JSON.stringify(
      {
        ok: true,
        dateText,
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
