const fs = require('fs/promises');
const path = require('path');
const vm = require('vm');

const SITE = 'https://cn.2firsts.com';
const HOMEPAGE_URL = `${SITE}/`;
const REPORT_DETAIL_URL = `${SITE}/report/detail?date=`;
const CHECK_MONTH_URL = `${SITE}/index.php/api/v2/report/checkMonth?date=`;
const PREVIEW_DIR = path.join(process.cwd(), 'preview');
const PREVIEW_JSON = path.join(PREVIEW_DIR, 'latest.json');
const PREVIEW_MD = path.join(PREVIEW_DIR, 'latest.md');
const TIME_ZONE = process.env.TIME_ZONE || 'Asia/Shanghai';
const FALLBACK_HOURS = Number(process.env.FALLBACK_HOURS || 48);
const FALLBACK_LIMIT = Number(process.env.FALLBACK_LIMIT || 10);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const PREVIEW_ONLY = isTruthy(process.env.PREVIEW_ONLY);
const TARGET_DATE = process.env.TARGET_DATE || getDateStringInTimeZone(new Date(), TIME_ZONE);
const FEISHU_WEBHOOK =
  process.env.FEISHU_WEBHOOK ||
  process.env.FEISHU_WEBHOOK_URL ||
  process.env.FEISHU_URL ||
  '';
const FEISHU_KEYWORD = (process.env.FEISHU_KEYWORD || '').trim();

async function main() {
  const startedAt = new Date().toISOString();

  console.log(`[info] targetDate=${TARGET_DATE}`);
  console.log(`[info] previewOnly=${PREVIEW_ONLY}`);

  const checkMonthResult = await safeRun(() => fetchCheckMonth(TARGET_DATE));
  const reportResult = await safeRun(() => fetchDailyReport(TARGET_DATE));

  let finalResult;

  if (reportResult.ok && reportResult.value.reportExists) {
    finalResult = {
      ...reportResult.value,
      diagnostics: {
        ...reportResult.value.diagnostics,
        checkMonth: checkMonthResult.ok ? checkMonthResult.value : { ok: false, error: checkMonthResult.error },
      },
    };
  } else {
    const fallbackResult = await fetchHomepageFallback({
      targetDate: TARGET_DATE,
      checkMonth: checkMonthResult.ok ? checkMonthResult.value : null,
      reportAttempt: reportResult.ok ? reportResult.value : null,
    });

    finalResult = {
      ...fallbackResult,
      diagnostics: {
        ...fallbackResult.diagnostics,
        checkMonth: checkMonthResult.ok ? checkMonthResult.value : { ok: false, error: checkMonthResult.error },
        reportAttempt: reportResult.ok ? reportResult.value.diagnostics : { ok: false, error: reportResult.error },
      },
    };
  }

  finalResult.generatedAt = startedAt;

  await writePreview(finalResult);

  if (PREVIEW_ONLY) {
    console.log(`[info] preview written to ${PREVIEW_JSON}`);
    return;
  }

  if (!FEISHU_WEBHOOK) {
    console.log('[warn] FEISHU_WEBHOOK is empty, skip sending.');
    return;
  }

  if (!Array.isArray(finalResult.items) || finalResult.items.length === 0) {
    console.log('[warn] no items available, skip sending.');
    return;
  }

  await sendToFeishu(finalResult);
}

async function fetchCheckMonth(targetDate) {
  const monthDate = `${targetDate.slice(0, 7)}-01`;
  const url = `${CHECK_MONTH_URL}${monthDate}`;
  const json = await fetchJson(url);
  const list = Array.isArray(json?.data?.list) ? json.data.list : [];
  const matched = list.find((item) => timestampToIsoDate(item?.date) === targetDate) || null;

  return {
    ok: true,
    url,
    monthDate,
    exists: Boolean(matched),
    cache: Boolean(json?.data?.cache),
    total: list.length,
    matched: matched
      ? {
          id: matched.id || null,
          title: cleanText(matched.title),
          date: timestampToIsoDate(matched.date),
        }
      : null,
  };
}

async function fetchDailyReport(targetDate) {
  const url = `${REPORT_DETAIL_URL}${targetDate}`;
  const html = await fetchText(url);
  const nuxt = extractNuxtState(html);
  const report = nuxt?.data?.[0]?.report || null;

  let reportTitle = '';
  let reportDate = '';
  let items = [];
  let strategy = 'detail_nuxt';

  if (report && report.content) {
    reportTitle = cleanText(report.title);
    reportDate = cleanText(report.seo_url);
    items = normalizeReportItems(report.content);
  } else {
    strategy = 'detail_dom_fallback';
    const domReport = extractReportFromHtml(html);
    reportTitle = domReport.title;
    reportDate = domReport.date;
    items = domReport.items;
  }

  const reportExists = reportDate === targetDate && items.length > 0;

  return {
    mode: reportExists ? 'report_detail' : 'report_detail_miss',
    strategy,
    requestedDate: targetDate,
    resolvedDate: reportDate || null,
    reportExists,
    title: reportTitle || null,
    sourceUrl: url,
    itemCount: items.length,
    items,
    diagnostics: {
      sourceUrl: url,
      resolvedDate: reportDate || null,
      reportTitle: reportTitle || null,
      itemCount: items.length,
      nuxtFound: Boolean(nuxt),
    },
  };
}

async function fetchHomepageFallback({ targetDate, checkMonth, reportAttempt }) {
  const html = await fetchText(HOMEPAGE_URL);
  const nuxt = extractNuxtState(html);

  let items = [];
  let strategy = 'homepage_nuxt';

  if (nuxt) {
    items = collectHomepageItemsFromNuxt(nuxt);
  }

  if (items.length === 0) {
    strategy = 'homepage_dom_fallback';
    items = extractHomepageItemsFromHtml(html);
  }

  const recentItems = pickRecentItems(items, FALLBACK_HOURS, FALLBACK_LIMIT);

  return {
    mode: 'fallback_news',
    strategy,
    requestedDate: targetDate,
    resolvedDate: null,
    reportExists: false,
    title: `2Firsts 近${FALLBACK_HOURS}小时热点`,
    sourceUrl: HOMEPAGE_URL,
    itemCount: recentItems.length,
    items: recentItems,
    diagnostics: {
      sourceUrl: HOMEPAGE_URL,
      itemCountBeforeFilter: items.length,
      itemCountAfterFilter: recentItems.length,
      checkMonthExists: Boolean(checkMonth?.exists),
      reportAttemptResolvedDate: reportAttempt?.resolvedDate || null,
      reportAttemptItemCount: reportAttempt?.itemCount || 0,
      fallbackHours: FALLBACK_HOURS,
      fallbackLimit: FALLBACK_LIMIT,
      nuxtFound: Boolean(nuxt),
    },
  };
}

function extractNuxtState(html) {
  const marker = 'window.__NUXT__=';
  const start = html.indexOf(marker);

  if (start === -1) {
    return null;
  }

  const scriptEnd = html.indexOf('</script>', start);

  if (scriptEnd === -1) {
    return null;
  }

  const snippet = html.slice(start, scriptEnd).trim();
  const sandbox = { window: {} };

  try {
    vm.runInNewContext(snippet, sandbox, { timeout: 3000 });
    return sandbox.window.__NUXT__ || null;
  } catch (error) {
    console.warn(`[warn] failed to evaluate __NUXT__: ${error.message}`);
    return null;
  }
}

function normalizeReportItems(content) {
  const items = Array.isArray(content) ? content : [];

  return items
    .map((item, index) => ({
      index: index + 1,
      title: cleanText(item?.title),
      source: cleanText(item?.source),
      articleUrl: absoluteUrl(item?.link),
      sourceUrl: null,
      timestamp: null,
      timeText: '',
      summary: '',
    }))
    .filter((item) => item.title && item.articleUrl);
}

function extractReportFromHtml(html) {
  const titleMatch =
    html.match(/早报\s*<span[^>]*>\/<\/span>\s*([0-9]{2}\.[0-9]{2})<\/i><i[^>]*>([0-9]{4})/i) || [];
  const date = titleMatch[1] && titleMatch[2] ? `${titleMatch[2]}-${titleMatch[1].replace('.', '-')}` : '';
  const title = titleMatch[1] && titleMatch[2] ? `早报 / ${titleMatch[1]} ${titleMatch[2]}` : '';
  const items = [];
  const itemRegex =
    /<a[^>]+href="([^"]+)"[^>]*class="[^"]*\bitem\b[^"]*"[\s\S]*?<div[^>]+class="title"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]+class="source"[^>]*>([\s\S]*?)<\/div>/gi;
  let match;
  let index = 0;

  while ((match = itemRegex.exec(html)) !== null) {
    index += 1;
    const articleUrl = absoluteUrl(match[1]);
    const itemTitle = cleanText(stripTags(match[2]));
    const source = cleanText(stripTags(match[3]));

    if (!itemTitle || !articleUrl.includes('/news/')) {
      continue;
    }

    items.push({
      index,
      title: itemTitle,
      source,
      articleUrl,
      sourceUrl: null,
      timestamp: null,
      timeText: '',
      summary: '',
    });
  }

  return { title, date, items };
}

function collectHomepageItemsFromNuxt(nuxt) {
  const collected = [];
  const visited = new WeakSet();

  function walk(node) {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (visited.has(node)) {
      return;
    }

    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }

    if (looksLikeNewsObject(node)) {
      collected.push(normalizeHomepageItem(node));
    }

    for (const value of Object.values(node)) {
      walk(value);
    }
  }

  walk(nuxt);

  return dedupeItems(collected);
}

function looksLikeNewsObject(node) {
  const title = cleanText(node?.title);

  if (!title) {
    return false;
  }

  if (Array.isArray(node?.content) && typeof node?.seo_url === 'string') {
    return false;
  }

  const link = typeof node?.link === 'string' ? node.link : '';
  const hasNewsLink = /\/news(\/|$)/.test(link);
  const hasArticleShape =
    typeof node?.description === 'string' ||
    typeof node?.image === 'string' ||
    typeof node?.share_image === 'string' ||
    typeof node?.banner === 'string';

  return hasNewsLink || (hasArticleShape && Number.isFinite(Number(node?.id)));
}

function normalizeHomepageItem(node) {
  const timestamp = firstNumber(node?.push_time, node?.preview_time, node?.create_time, node?.date);
  const articleUrl = absoluteUrl(node?.link || buildArticleUrl(node));

  return {
    index: 0,
    title: cleanText(node?.title),
    source: cleanText(node?.source?.title || node?.tag || node?.author?.username || ''),
    articleUrl,
    sourceUrl: null,
    timestamp,
    timeText: cleanText(node?.date_string || ''),
    summary: cleanText(node?.description || ''),
    image: absoluteUrl(node?.image || node?.share_image || ''),
  };
}

function buildArticleUrl(node) {
  if (node?.id) {
    return `/news/detail?id=${node.id}`;
  }

  if (typeof node?.seo_url === 'string' && node.seo_url) {
    return `/news/${node.seo_url}`;
  }

  return '';
}

function extractHomepageItemsFromHtml(html) {
  const items = [];
  const anchorRegex = /<a[^>]+href="([^"]*\/news[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html)) !== null) {
    const articleUrl = absoluteUrl(match[1]);
    const block = match[2];
    const titleMatch =
      block.match(/<div[^>]+class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      block.match(/alt="([^"]+)"/i);
    const timeMatch = block.match(/<span[^>]+class="[^"]*\btime\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const title = cleanText(stripTags(titleMatch?.[1] || ''));
    const timeText = cleanText(stripTags(timeMatch?.[1] || ''));

    if (!title) {
      continue;
    }

    items.push({
      index: 0,
      title,
      source: '',
      articleUrl,
      sourceUrl: null,
      timestamp: null,
      timeText,
      summary: '',
    });
  }

  return dedupeItems(items);
}

function pickRecentItems(items, hours, limit) {
  const now = Date.now();
  const maxAgeMs = hours * 60 * 60 * 1000;

  const sorted = [...items].sort((a, b) => {
    const aScore = a.timestamp || 0;
    const bScore = b.timestamp || 0;
    return bScore - aScore;
  });

  const recent = sorted.filter((item) => {
    if (item.timestamp) {
      return now - item.timestamp * 1000 <= maxAgeMs;
    }

    return looksRecentByText(item.timeText, hours);
  });

  const chosen = (recent.length > 0 ? recent : sorted).slice(0, limit);

  return chosen.map((item, index) => ({ ...item, index: index + 1 }));
}

function looksRecentByText(text, hours) {
  if (!text) {
    return false;
  }

  const normalized = cleanText(text);

  if (/分钟前|刚刚/.test(normalized)) {
    return true;
  }

  const hourMatch = normalized.match(/(\d+)\s*小时前/);

  if (hourMatch) {
    return Number(hourMatch[1]) <= hours;
  }

  return /今天|昨日|昨天/.test(normalized);
}

async function writePreview(result) {
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  await fs.writeFile(PREVIEW_JSON, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.writeFile(PREVIEW_MD, buildPreviewMarkdown(result), 'utf8');
}

function buildPreviewMarkdown(result) {
  const title = buildFeishuTitle(result);
  const lines = [
    '# 2Firsts Preview',
    '',
    `- 目标日期: ${result.requestedDate}`,
    `- 模式: ${result.mode}`,
    `- 策略: ${result.strategy}`,
    `- 标题: ${title}`,
    `- 条数: ${result.itemCount || 0}`,
    `- 来源页: ${result.sourceUrl || ''}`,
    '',
    '## 内容',
    '',
  ];

  if (!result.items || result.items.length === 0) {
    lines.push('无可用内容。');
    return `${lines.join('\n')}\n`;
  }

  for (const item of result.items) {
    lines.push(`${item.index}. ${item.title}`);
    lines.push(`[链接](${item.articleUrl || ''})`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function sendToFeishu(result) {
  const payload = buildFeishuPostPayload(result);

  const response = await fetch(FEISHU_WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`Feishu webhook failed: ${response.status} ${raw}`);
  }

  console.log('[info] feishu send success');
}

function buildFeishuPostPayload(result) {
  const content = [];
  const title = buildFeishuTitle(result);

  if (FEISHU_KEYWORD) {
    content.push([{ tag: 'text', text: FEISHU_KEYWORD }]);
  }

  for (const item of result.items) {
    content.push([{ tag: 'text', text: `${item.index}. ${item.title}` }]);
    content.push([{ tag: 'a', text: '链接', href: item.articleUrl }]);
  }

  return {
    msg_type: 'post',
    content: {
      post: {
        zh_cn: {
          title,
          content,
        },
      },
    },
  };
}

function buildFeishuTitle(result) {
  if (result.mode === 'report_detail') {
    return `2Firsts 今日早报 ${result.resolvedDate || result.requestedDate}`;
  }

  return `2Firsts 首页热点新闻 ${result.requestedDate}`;
}

async function fetchJson(url) {
  const response = await fetch(url, buildRequestOptions());
  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`request failed ${response.status}: ${url}`);
  }

  return JSON.parse(raw);
}

async function fetchText(url) {
  const response = await fetch(url, buildRequestOptions());
  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`request failed ${response.status}: ${url}`);
  }

  return raw;
}

function buildRequestOptions() {
  return {
    headers: {
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
}

function dedupeItems(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = item.articleUrl || item.title;

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function absoluteUrl(url) {
  if (!url || typeof url !== 'string') {
    return '';
  }

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  if (url.startsWith('//')) {
    return `https:${url}`;
  }

  if (url.startsWith('/')) {
    return `${SITE}${url}`;
  }

  return `${SITE}/${url.replace(/^\.\//, '')}`;
}

function cleanText(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return htmlDecode(String(value))
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function htmlDecode(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function timestampToIsoDate(timestamp) {
  const value = Number(timestamp);

  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }

  return getDateStringInTimeZone(new Date(value * 1000), TIME_ZONE);
}

function getDateStringInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);

    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }

  return null;
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

async function safeRun(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

main().catch(async (error) => {
  console.error(`[fatal] ${error.stack || error.message}`);

  const failurePayload = {
    generatedAt: new Date().toISOString(),
    requestedDate: TARGET_DATE,
    mode: 'error',
    strategy: 'fatal',
    title: null,
    sourceUrl: '',
    itemCount: 0,
    items: [],
    error: error.message,
  };

  try {
    await writePreview(failurePayload);
  } catch (writeError) {
    console.error(`[fatal] failed to write preview: ${writeError.message}`);
  }

  process.exitCode = 1;
});
