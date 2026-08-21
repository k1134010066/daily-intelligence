import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const crawlerToken = process.env.CRAWLER_INGEST_TOKEN || '';
const adminPassword = String(process.env.ADMIN_PASSWORD || '');
const adminSessionTtlMs = Math.max(15 * 60_000, Number(process.env.ADMIN_SESSION_TTL_MINUTES || 480) * 60_000);
const adminSessions = new Map();
const adminSessionCookie = 'daily_intelligence_session';
const defaultMediaCrawlerRoot = path.join(__dirname, 'vendor/MediaCrawler');
const xhsMcpUrl = process.env.XHS_MCP_URL || 'http://127.0.0.1:18060/mcp';
const xhsMcpBearerToken = process.env.XHS_MCP_BEARER_TOKEN || '';
const xhsMcpTimeoutMs = Math.max(5_000, Number(process.env.XHS_MCP_TIMEOUT_MS || 120_000));
const twitterCliPath = process.env.TWITTER_CLI_PATH || 'twitter';
const twitterCliTimeoutSeconds = Math.max(30, Number(process.env.TWITTER_CLI_TIMEOUT_SECONDS || 120));
const automationConfigPath = path.join(__dirname, 'config/automation.json');
const keywordCatalogPath = path.join(__dirname, 'config/keyword-catalog.json');
const agentResultPath = path.join(__dirname, 'runtime/agent-latest.json');
const reviewImageDir = path.join(__dirname, 'runtime/review-images');
const latestCollectionPath = path.join(__dirname, 'runtime/latest-collection.json');

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2 && pair[0]));
}

function passwordMatches(candidate) {
  const actual = Buffer.from(String(candidate || ''));
  const expected = Buffer.from(adminPassword);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isAuthenticated(req) {
  if (!adminPassword) return true;
  const token = parseCookies(req)[adminSessionCookie];
  if (!token) return false;
  const expiresAt = adminSessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function authCookie(token, req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https';
  return `${adminSessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(adminSessionTtlMs / 1000)}${secure ? '; Secure' : ''}`;
}

function resolveProjectPath(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, raw);
}

function resolveCommandPath(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return raw.includes('/') ? resolveProjectPath(raw, fallback) : raw;
}

async function loadMediaCrawlerConfig() {
  try {
    const config = JSON.parse(await readFile(path.join(__dirname, 'config/mediacrawler.local.json'), 'utf8'));
    return {
      root: resolveProjectPath(process.env.MEDIACRAWLER_ROOT || config.root, defaultMediaCrawlerRoot),
      platforms: config.platforms || { xhs: '小红书', dy: '抖音' },
      dataDirs: config.dataDirs || { xhs: 'xhs', dy: 'douyin' },
      maxItems: Number(config.maxItems || 30)
    };
  } catch {
    return { root: resolveProjectPath(process.env.MEDIACRAWLER_ROOT, defaultMediaCrawlerRoot), platforms: { xhs: '小红书', dy: '抖音' }, dataDirs: { xhs: 'xhs', dy: 'douyin' }, maxItems: 30 };
  }
}

const mediaCrawlerConfig = await loadMediaCrawlerConfig();
const collectorPlatforms = { ...mediaCrawlerConfig.platforms, twitter: '推特' };
let keywordCatalog = JSON.parse(await readFile(keywordCatalogPath, 'utf8'));

function cleanKeywordList(value, limit = 8) {
  return Array.isArray(value) ? [...new Set(value.map(item => String(item).trim()).filter(Boolean))].slice(0, limit) : [];
}

function selectedSearchSpecs(selectedTracks = []) {
  return keywordCatalog
    .filter(topic => selectedTracks.includes(topic.id))
    .flatMap(topic => cleanKeywordList(topic.keywords).map(term => ({ term, topicId: topic.id, topicLabel: topic.label })));
}

function expandedKeywords(selectedTracks = []) {
  return [...new Set(selectedSearchSpecs(selectedTracks).map(item => item.term))];
}

const defaultAgentPrompt = '请基于输入的采集内容提炼高频行业主题，输出简洁、可执行的结构化中文情报。只使用输入中存在的信息，不要编造事实或链接。';

const defaultAutomationConfig = {
  keywords: ['线香', '中式线香', '线香推荐', '线香文化', 'AI', 'AI教程', 'AI新闻', 'AI最新资讯', 'Codex', 'Codex教程', 'Codex使用技巧', 'Codex最新资讯'],
  selectedTracks: ['incense', 'ai', 'codex'],
  scheduleTimes: ['07:00', '12:00', '18:00'],
  enabledPlatforms: ['xhs', 'dy'],
  timezone: 'Asia/Shanghai',
  loginType: 'qrcode',
  headless: false,
  maxNotes: 30,
  getComments: true,
  saveDataPath: resolveProjectPath(process.env.COLLECTION_DATA_PATH, path.join(__dirname, 'runtime/mediacrawler')),
  agentEnabled: true,
  agentProvider: 'auto',
  agentModel: 'gpt-4o-mini',
  agentPrompt: defaultAgentPrompt,
  autoAcceptCdpPrompt: true,
  cdpPromptTimeoutSeconds: 60,
  runner: resolveCommandPath(process.env.MEDIACRAWLER_PYTHON, path.join(defaultMediaCrawlerRoot, '.venv/bin/python')),
  runnerScript: resolveProjectPath(process.env.MEDIACRAWLER_RUNNER_SCRIPT, path.join(__dirname, 'scripts/mediacrawler_runner.py')),
  timeoutMinutes: 25,
  twitterCliPath,
  twitterCliTimeoutSeconds,
  collectionWindowDays: 90,
  minimumLikes: 1_000,
  collector: 'xiaohongshu-mcp',
  xhsMcpUrl
};

async function loadAutomationConfig() {
  try {
    const stored = JSON.parse(await readFile(automationConfigPath, 'utf8'));
    const legacyKeywords = [...(stored.personalKeywords || []), ...(stored.industryKeywords || [])];
    const keywords = Array.isArray(stored.keywords) ? stored.keywords : legacyKeywords;
    const validStoredTracks = Array.isArray(stored.selectedTracks) ? stored.selectedTracks.filter(id => keywordCatalog.some(topic => topic.id === id)) : [];
    const selectedTracks = validStoredTracks.length ? validStoredTracks : keywordCatalog.filter(track => track.keywords.some(keyword => keywords.includes(keyword))).map(track => track.id);
    const resolvedTracks = selectedTracks.length ? selectedTracks : defaultAutomationConfig.selectedTracks;
    const enabledPlatforms = Array.isArray(stored.enabledPlatforms) ? stored.enabledPlatforms.filter(platform => Object.hasOwn(collectorPlatforms, platform)) : defaultAutomationConfig.enabledPlatforms;
    return {
      ...defaultAutomationConfig,
      ...stored,
      saveDataPath: resolveProjectPath(process.env.COLLECTION_DATA_PATH || stored.saveDataPath, defaultAutomationConfig.saveDataPath),
      runner: resolveCommandPath(process.env.MEDIACRAWLER_PYTHON || stored.runner, defaultAutomationConfig.runner),
      runnerScript: resolveProjectPath(process.env.MEDIACRAWLER_RUNNER_SCRIPT || stored.runnerScript, defaultAutomationConfig.runnerScript),
      twitterCliPath: process.env.TWITTER_CLI_PATH || stored.twitterCliPath || twitterCliPath,
      keywords: expandedKeywords(resolvedTracks),
      selectedTracks: resolvedTracks,
      enabledPlatforms: enabledPlatforms.length ? enabledPlatforms : defaultAutomationConfig.enabledPlatforms,
      collectionWindowDays: 90,
      minimumLikes: 1_000,
      collector: stored.collector || 'xiaohongshu-mcp',
      xhsMcpUrl
    };
  } catch {
    return { ...defaultAutomationConfig };
  }
}

let automationConfig = await loadAutomationConfig();

async function saveAutomationConfig() {
  await mkdir(path.dirname(automationConfigPath), { recursive: true });
  await writeFile(automationConfigPath, `${JSON.stringify(automationConfig, null, 2)}\n`, 'utf8');
}

async function saveKeywordCatalog() {
  await writeFile(keywordCatalogPath, `${JSON.stringify(keywordCatalog, null, 2)}\n`, 'utf8');
}

const seedState = {
  summary: { newTrends: 12, pendingReview: 6, todayPushed: '2/3' },
  review: {
    id: 'review-001',
    type: 'daily-one-image',
    status: 'pending',
    title: '每日情报一图流',
    subtitle: '汇总当日采集内容并按相关度排序，审核后进入分发队列。',
    tags: [],
    platform: '多平台',
    publishedAt: '待生成',
    image: '/api/review/image.svg',
    sourceUrl: '/api/review/image.svg',
    items: []
  },
  trends: [
    { rank: 1, title: '露营装备轻量化趋势升温', insight: '轻量化装备讨论度持续上升', platforms: ['小红书', '抖音', '视频号'], change: '+78%' },
    { rank: 2, title: '早C晚A护肤组合讨论增长', insight: '护肤组合搭配成为热门话题', platforms: ['抖音', '小红书'], change: '+52%' },
    { rank: 3, title: '职场穿搭通勤风持续走热', insight: '通勤穿搭内容互动明显增加', platforms: ['小红书', '视频号'], change: '+41%' },
    { rank: 4, title: '户外徒步装备需求上升', insight: '徒步装备选购关注度提升', platforms: ['抖音', '小红书'], change: '+35%' }
  ],
  contents: [
    { id: 'content-001', title: '露营新手必备清单 2024', summary: '新手露营装备清单与避坑指南，轻松开启户外之旅', tags: ['露营装备', '新手攻略'], platform: '小红书', time: '08:32', likes: '1,246', collects: '892', comments: '156', image: '/assets/thumb-camp.svg', url: 'https://example.com/source/content-001' },
    { id: 'content-002', title: '早C晚A搭配实测分享', summary: '不同肤质的早C晚A护肤组合实测，温和提亮不刺激', tags: ['护肤分享', '早C晚A'], platform: '抖音', time: '07:46', likes: '2,318', collects: '1,205', comments: '243', image: '/assets/thumb-skincare.svg', url: 'https://example.com/source/content-002' },
    { id: 'content-003', title: '职场通勤风穿搭指南', summary: '适合不同场合的通勤穿搭灵感，简约又高级', tags: ['职场穿搭', '通勤风'], platform: '视频号', time: '07:18', likes: '986', collects: '612', comments: '98', image: '/assets/thumb-workwear.svg', url: 'https://example.com/source/content-003' }
  ],
  agentDigest: { summary: '', markdown: '', news: [], provider: 'seed', generatedAt: null },
  collectionNotice: '',
  lastUpdated: '今天 07:05',
  channels: { wechat: '待配置', enterpriseWechat: '待配置', feishu: '待配置', miniProgram: '用户订阅后可用' }
};

const state = structuredClone(seedState);

function fallbackImageFor(platform, id = '') {
  const options = platform === '小红书' ? ['/assets/thumb-camp.svg', '/assets/thumb-skincare.svg', '/assets/thumb-workwear.svg'] : ['/assets/review-preview.svg', '/assets/thumb-workwear.svg'];
  const seed = [...String(id)].reduce((total, char) => total + char.charCodeAt(0), 0);
  return options[seed % options.length];
}

function formatCrawlerTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return String(value || '未知时间');
  const date = new Date(number < 10_000_000_000 ? number * 1000 : number);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-');
}

function normalizeTimestamp(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number < 10_000_000_000 ? number * 1000 : number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function xhsPublishTimestamp(item, card, id) {
  const directTimestamp = normalizeTimestamp(
    card?.time || card?.createTime || card?.create_time || card?.publishTime || card?.publish_time ||
    item?.time || item?.createTime || item?.create_time || item?.publishTime || item?.publish_time
  );
  if (directTimestamp > 0) return directTimestamp;

  // Xiaohongshu note IDs use a 24-character ObjectId. Its first four bytes
  // are the Unix creation time; this exactly matches note.time from the MCP
  // detail response and avoids opening every note solely to obtain its date.
  if (!/^[0-9a-f]{24}$/i.test(id)) return 0;
  const timestamp = Number.parseInt(id.slice(0, 8), 16) * 1000;
  const earliestReasonableDate = Date.UTC(2010, 0, 1);
  const latestReasonableDate = Date.now() + 24 * 60 * 60 * 1000;
  return timestamp >= earliestReasonableDate && timestamp <= latestReasonableDate ? timestamp : 0;
}

function recentItems(items, days = 90) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return items.filter(item => Number(item.timestamp) > 0 && Number(item.timestamp) >= cutoff);
}

function metricNumber(value) {
  const text = String(value ?? 0).trim().toLowerCase().replace(/,/g, '');
  const match = text.match(/^([\d.]+)\s*(万|w|k)?/i);
  if (!match) return 0;
  const multiplier = match[2] === '万' || match[2] === 'w' ? 10_000 : match[2] === 'k' ? 1_000 : 1;
  return Math.max(0, Number(match[1]) * multiplier || 0);
}

function normalizedMatchText(value = '') {
  return String(value).toLowerCase().replace(/[\s#，,。.!！?？、_\-—:："'“”‘’（）()【】\[\]]+/g, '');
}

function relevanceFragments(item) {
  const topic = keywordCatalog.find(entry => entry.id === item.topicId) || keywordCatalog.find(entry => entry.label === item.coreKeyword);
  const terms = [...new Set([topic?.label, ...(topic?.keywords || []), item.sourceKeyword, item.coreKeyword].filter(Boolean))];
  const fragments = new Set();
  terms.forEach(term => {
    const normalized = normalizedMatchText(term);
    if (!normalized) return;
    fragments.add(normalized);
    if (/^[\u3400-\u9fff]{4,}$/.test(normalized)) {
      for (let index = 0; index < normalized.length - 1; index += 1) fragments.add(normalized.slice(index, index + 2));
    }
  });
  return [...fragments].filter(fragment => fragment.length >= 2 || /^(ai)$/i.test(fragment));
}

function isKeywordRelevant(item) {
  const searchableText = normalizedMatchText(`${item.title || ''} ${item.summary || ''} ${item.sourceKeyword || ''}`);
  return Boolean(searchableText) && relevanceFragments(item).some(fragment => searchableText.includes(fragment));
}

function qualifyCollectedItems(items) {
  const windowDays = 90;
  const minimumLikes = 1_000;
  const cutoff = Date.now() - windowDays * 86_400_000;
  const rejected = { outsideWindow: 0, belowMinimumLikes: 0, unrelated: 0 };
  const likeDistribution = { upTo1000: 0, between1000And5000: 0, between5000And10000: 0, between10000And40000: 0, above40000: 0 };
  const qualified = [];
  for (const item of items) {
    if (!Number(item.timestamp) || Number(item.timestamp) < cutoff) { rejected.outsideWindow += 1; continue; }
    if (!isKeywordRelevant(item)) { rejected.unrelated += 1; continue; }
    const likes = metricNumber(item.likes);
    if (likes <= 1_000) likeDistribution.upTo1000 += 1;
    else if (likes <= 5_000) likeDistribution.between1000And5000 += 1;
    else if (likes <= 10_000) likeDistribution.between5000And10000 += 1;
    else if (likes <= 40_000) likeDistribution.between10000And40000 += 1;
    else likeDistribution.above40000 += 1;
    if (likes <= minimumLikes) { rejected.belowMinimumLikes += 1; continue; }
    qualified.push(item);
  }
  qualified.sort((a, b) => metricNumber(b.likes) - metricNumber(a.likes) || Number(b.timestamp || 0) - Number(a.timestamp || 0));
  const selectedTopics = keywordCatalog.filter(topic => automationConfig.selectedTracks.includes(topic.id));
  const topicCounts = selectedTopics.map(topic => ({
    topicId: topic.id,
    topicLabel: topic.label,
    count: qualified.filter(item => item.topicId === topic.id || item.coreKeyword === topic.label).length
  }));
  return { items: qualified.slice(0, automationConfig.maxNotes), rawCount: items.length, rejected, likeDistribution, topicCounts, windowDays, minimumLikes };
}

function noQualifiedContentNotice(topicLabels = []) {
  const scope = topicLabels.length ? `“${topicLabels.join('、')}”` : '当前所选主题';
  return `${scope}近3个月内暂无点赞超过1000且与关键词相关的内容，本轮未生成重点内容。`;
}

function qualificationNotice(report) {
  const missingTopics = report.topicCounts.filter(topic => topic.count === 0).map(topic => topic.topicLabel);
  if (!report.items.length) return noQualifiedContentNotice(missingTopics);
  if (missingTopics.length) return `“${missingTopics.join('、')}”近3个月内暂无点赞超过1000且与关键词相关的内容；其他主题已正常采集。`;
  return '';
}

function reviewItemScore(item) {
  const title = String(item.title || '').toLowerCase();
  const coreKeyword = String(item.coreKeyword || '').toLowerCase();
  const sourceKeyword = String(item.sourceKeyword || '').toLowerCase();
  const titleRelevance = (coreKeyword && title.includes(coreKeyword) ? 45 : 0) + (sourceKeyword && title.includes(sourceKeyword) ? 30 : 0);
  // For the one-image ranking, likes are the clearest high-traffic signal;
  // keep saves/comments as supporting signals without letting them dominate.
  const engagement = metricNumber(item.likes) * 2.4 + metricNumber(item.collects) * 1.2 + metricNumber(item.comments) * 1.4;
  const engagementScore = Math.min(45, Math.log10(engagement + 1) * 10);
  const ageDays = item.timestamp ? Math.max(0, (Date.now() - Number(item.timestamp)) / 86_400_000) : 30;
  const recencyScore = Math.max(0, 20 - ageDays * .65);
  return Math.round((titleRelevance + engagementScore + recencyScore) * 10) / 10;
}

function rankedReviewItems(items, limit = 7) {
  const seenTitles = new Set();
  // The review image is a decision aid for the current cycle. Never backfill
  // its fixed ranking with stale posts just to reach seven entries.
  return recentItems(items, 90)
    .map(item => ({ ...item, reviewScore: reviewItemScore(item) }))
    .sort((a, b) => b.reviewScore - a.reviewScore || Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .filter(item => {
      const key = String(item.title || '').replace(/\s+/g, '').toLowerCase();
      if (!key || key.length < 4 || /^未命名|^无标题|^untitled/i.test(key) || seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    })
    .slice(0, limit)
    .map((item, index) => ({
      rank: index + 1,
      id: item.id,
      title: item.title,
      keyword: item.coreKeyword || item.sourceKeyword || item.tags?.[0] || '未分类',
      platform: item.platform,
      time: item.time,
      likes: item.likes,
      collects: item.collects,
    comments: item.comments,
    score: item.reviewScore,
    url: item.url,
    image: item.image || item.sourceImage || fallbackImageFor(item.platform, item.id)
  }));
}

function reviewDateLabel(date = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: automationConfig.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).replace(/\//g, '-');
}

function buildDailyReview(items, analysis = null) {
  const ranked = rankedReviewItems(items, 7);
  const tags = [...new Set(ranked.map(item => item.keyword).filter(Boolean))].slice(0, 5);
  const generatedAt = new Date().toISOString();
  const date = reviewDateLabel();
  return {
    ...state.review,
    id: `daily-one-image-${date}`,
    type: 'daily-one-image',
    status: 'pending',
    title: `${date} 每日情报一图流`,
    subtitle: `从本轮采集内容中选出 ${ranked.length} 条，优先近期内容，并按关键词相关度与互动表现排序。`,
    summary: String(analysis?.summary || `本轮共采集 ${items.length} 条有效内容。`).slice(0, 100),
    tags,
    platform: [...new Set(ranked.map(item => item.platform))].join('、') || '多平台',
    publishedAt: date,
    image: `/api/review/image.svg?v=${encodeURIComponent(generatedAt)}`,
    sourceUrl: `/api/review/image.svg?v=${encodeURIComponent(generatedAt)}`,
    items: ranked,
    generatedAt,
    approvedAt: null,
    approvedImageUrl: null,
    dispatch: null
  };
}

function xmlEscape(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

function textLines(value, width = 24, limit = 2) {
  const chars = [...String(value || '').replace(/\s+/g, ' ').trim()];
  const lines = [];
  while (chars.length && lines.length < limit) lines.push(chars.splice(0, width).join(''));
  if (chars.length && lines.length) lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(1, width - 1))}…`;
  return lines;
}

function createReviewSvg(review = state.review) {
  const items = Array.isArray(review.items) ? review.items.slice(0, 7) : [];
  const rowTop = 318;
  const rowBottom = 1468;
  const availableHeight = rowBottom - rowTop;
  const minimumGap = 18;
  const rowHeight = items.length
    ? Math.min(260, Math.floor((availableHeight - minimumGap * Math.max(0, items.length - 1)) / items.length))
    : 0;
  const rowGap = items.length > 1 ? (availableHeight - rowHeight * items.length) / (items.length - 1) : 0;
  const singleRowOffset = items.length === 1 ? (availableHeight - rowHeight) / 2 : 0;
  const imageWidth = 160;
  const imageX = 82;
  const contentX = imageX + imageWidth + 28;
  const clips = items.map((item, index) => {
    const y = rowTop + singleRowOffset + index * (rowHeight + rowGap);
    return `<clipPath id="review-image-${index}"><rect x="${imageX}" y="${y + 14}" width="${imageWidth}" height="${Math.max(96, rowHeight - 28)}" rx="14"/></clipPath>`;
  }).join('');
  const rows = items.map((item, index) => {
    const y = rowTop + singleRowOffset + index * (rowHeight + rowGap);
    const imageHeight = Math.max(96, rowHeight - 28);
    const imageSource = String(item.image || '');
    const imageHref = imageSource.startsWith('/') ? imageSource : `/api/review/item-image/${encodeURIComponent(item.id)}`;
    const titleLines = textLines(item.title, 21, 2);
    const title = titleLines.map((line, lineIndex) => `<text x="${contentX}" y="${y + 47 + lineIndex * 34}" class="item-title">${xmlEscape(line)}</text>`).join('');
    return `<g>
      <rect x="62" y="${y}" width="956" height="${rowHeight}" rx="24" class="item-card"/>
      <rect x="${imageX}" y="${y + 14}" width="${imageWidth}" height="${imageHeight}" rx="14" class="image-placeholder"/>
      <image href="${xmlEscape(imageHref)}" x="${imageX}" y="${y + 14}" width="${imageWidth}" height="${imageHeight}" preserveAspectRatio="xMidYMid slice" clip-path="url(#review-image-${index})"/>
      <circle cx="${imageX + 20}" cy="${y + 34}" r="24" class="rank-circle"/>
      <text x="${imageX + 20}" y="${y + 43}" text-anchor="middle" class="rank-text">${index + 1}</text>
      ${title}
      <text x="${contentX}" y="${y + rowHeight - 24}" class="item-meta">#${xmlEscape(item.keyword)} · ${xmlEscape(item.platform)} · ${xmlEscape(item.time)}</text>
      <text x="966" y="${y + 43}" text-anchor="end" class="score-label">相关度</text>
      <text x="966" y="${y + 80}" text-anchor="end" class="score-value">${xmlEscape(item.score)}</text>
      <text x="966" y="${y + rowHeight - 24}" text-anchor="end" class="metric-text">赞 ${xmlEscape(item.likes)} · 藏 ${xmlEscape(item.collects)} · 评 ${xmlEscape(item.comments)}</text>
    </g>`;
  }).join('');
  const empty = items.length ? '' : '<text x="540" y="760" text-anchor="middle" class="empty-copy">暂无可生成的一图流内容</text>';
  const tags = (review.tags || []).map(tag => `#${tag}`).join('  ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1600" viewBox="0 0 1080 1600">
  <defs>${clips}</defs>
  <style>
    .bg{fill:#08101f}.accent{fill:#ff8b27}.header-small{font:600 24px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;letter-spacing:4px;fill:#ff9b45}.title{font:750 60px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#f7f9fc}.date{font:400 24px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#8f9db4}.summary{font:400 27px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#cbd4e2}.item-card{fill:#111d31;stroke:#263a59;stroke-width:2}.image-placeholder{fill:#1a2a43}.rank-circle{fill:#ff8b27;stroke:#fff;stroke-width:3}.rank-text{font:750 25px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#1a1420}.item-title{font:650 27px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#f4f7fb}.item-meta{font:400 19px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#8f9db4}.score-label{font:400 18px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#7788a3}.score-value{font:700 29px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#ff9b45}.metric-text{font:400 16px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#8495ae}.footer{font:400 20px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#7788a3}.empty-copy{font:500 30px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;fill:#8f9db4}
  </style>
  <rect width="1080" height="1600" class="bg"/>
  <rect x="0" y="0" width="14" height="1600" class="accent"/>
  <text x="62" y="76" class="header-small">DAILY INTELLIGENCE</text>
  <text x="62" y="154" class="title">每日行业情报 TOP ${items.length || 7}</text>
  <text x="62" y="205" class="date">${xmlEscape(review.publishedAt || reviewDateLabel())} · 按相关度 / 互动表现 / 发布时间排序</text>
  <rect x="62" y="235" width="956" height="58" rx="18" fill="#17253d"/>
  <text x="88" y="273" class="summary">${xmlEscape(textLines(review.summary || review.subtitle, 48, 1)[0] || '')}</text>
  ${rows}${empty}
  <line x1="62" y1="1492" x2="1018" y2="1492" stroke="#263a59" stroke-width="2"/>
  <text x="62" y="1534" class="footer">${xmlEscape(tags || '每日情报 · 人工审核后分发')}</text>
  <text x="1018" y="1534" text-anchor="end" class="footer">微信 · 企业微信 · 飞书</text>
</svg>`;
}

function parseTags(value, fallback) {
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item.name || item.tag || '').filter(Boolean).slice(0, 5);
  const text = String(value || '');
  const hashtags = [...text.matchAll(/#([^#[\]#\n]+?)(?:\[话题\])?#/g)].map(match => match[1].trim()).filter(Boolean);
  const keywords = text.split(/[，,、|\n]/).map(item => item.replace(/^#|#$/g, '').trim()).filter(item => item.length > 1 && item.length < 30);
  return [...new Set((hashtags.length ? hashtags : keywords.length ? keywords : [fallback]).filter(Boolean))].slice(0, 5);
}

function crawlerDataDir(crawlerPlatform) {
  return mediaCrawlerConfig.dataDirs?.[crawlerPlatform] || crawlerPlatform;
}

function mediaDataRoots() {
  return [...new Set([
    path.join(mediaCrawlerConfig.root, 'data'),
    automationConfig.saveDataPath
  ].filter(Boolean).map(item => path.resolve(item)))];
}

function normalizeMediaCrawlerItem(item, crawlerPlatform) {
  const platform = mediaCrawlerConfig.platforms[crawlerPlatform] || crawlerPlatform;
  const description = String(item.desc || item.description || item.content || '').trim();
  const title = String(item.title || description.split('\n')[0] || `${platform}内容`).trim();
  const id = String(item.note_id || item.aweme_id || item.video_id || item.id || `${crawlerPlatform}-${item.time || Date.now()}`);
  const sourceImage = firstImage(item.image_list || item.cover_url || item.thumbnail || item.image);
  const sourceKeyword = String(item.source_keyword || '').trim();
  const tags = parseTags(item.tag_list || description, sourceKeyword);
  const timestamp = normalizeTimestamp(item.time || item.create_time || item.publishedAt);
  return {
    id,
    title,
    summary: description.slice(0, 120) || title,
    tags,
    coreKeyword: sourceKeyword || tags[0] || '',
    platform,
    time: formatCrawlerTime(item.time || item.create_time || item.publishedAt),
    timestamp,
    publishedAt: timestamp ? new Date(timestamp).toISOString() : '',
    likes: String(item.liked_count ?? item.like_count ?? item.likes ?? 0),
    collects: String(item.collected_count ?? item.collect_count ?? item.favorites ?? 0),
    comments: String(item.comment_count ?? item.comments ?? 0),
    author: String(item.nickname || item.author_name || item.user_nickname || '未知作者'),
    image: sourceImage.startsWith('/') ? sourceImage : fallbackImageFor(platform, id),
    sourceImage,
    url: String(item.note_url || item.aweme_url || item.video_url || item.share_url || item.url || '#'),
    sourceKeyword: String(item.source_keyword || ''),
    source: 'mediacrawler'
  };
}

function firstImage(value) {
  if (Array.isArray(value)) return String(value.find(Boolean) || '');
  return String(value || '').split(',')[0].trim();
}

async function resolveLocalMedia(crawlerPlatform, id) {
  for (const root of mediaDataRoots()) {
    const mediaDir = path.join(root, crawlerDataDir(crawlerPlatform), 'images', id);
    try {
      const names = await readdir(mediaDir);
      const name = names.find(item => /\.(jpg|jpeg|png|webp|gif)$/i.test(item));
      if (name) return `/api/crawler-media/${encodeURIComponent(crawlerPlatform)}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
    } catch { /* try the next data root */ }
  }
  return '';
}

async function readMediaCrawlerData(platforms = Object.keys(mediaCrawlerConfig.platforms)) {
  const items = [];
  const files = [];
  for (const crawlerPlatform of platforms.filter(platform => mediaCrawlerConfig.platforms[platform])) {
    const candidateFiles = [];
    for (const root of mediaDataRoots()) {
      const jsonDir = path.join(root, crawlerDataDir(crawlerPlatform), 'json');
      try {
        const names = await readdir(jsonDir);
        for (const name of names.filter(item => /^search_contents_.*\.(json|jsonl)$/.test(item))) candidateFiles.push(path.join(jsonDir, name));
      } catch { /* data root may not exist yet */ }
    }
    const latestFile = (await Promise.all([...new Set(candidateFiles)].map(async filePath => {
      try {
        const fileStat = await stat(filePath);
        return { path: filePath, mtime: fileStat.mtime };
      } catch {
        return null;
      }
    }))).filter(Boolean).sort((a, b) => b.mtime - a.mtime)[0];
    if (!latestFile) continue;

    const filePath = latestFile.path;
    const name = path.basename(filePath);
    files.push({ platform: crawlerPlatform, name, path: filePath, mtime: latestFile.mtime.toISOString() });
    try {
      const raw = await readFile(filePath, 'utf8');
      if (name.endsWith('.jsonl')) {
        for (const line of raw.split('\n').filter(Boolean)) {
          try {
            const item = normalizeMediaCrawlerItem(JSON.parse(line), crawlerPlatform);
            item.image = await resolveLocalMedia(crawlerPlatform, item.id) || item.image;
            items.push(item);
          } catch { /* skip malformed line */ }
        }
      } else {
        const parsed = JSON.parse(raw);
        for (const rawItem of (Array.isArray(parsed) ? parsed : [parsed])) {
          const item = normalizeMediaCrawlerItem(rawItem, crawlerPlatform);
          item.image = await resolveLocalMedia(crawlerPlatform, item.id) || item.image;
          items.push(item);
        }
      }
    } catch { /* ignore an incomplete or unreadable export */ }
  }
  const unique = [...new Map(items.map(item => [item.id, item])).values()];
  unique.sort((a, b) => {
    const timestampDiff = Number(b.timestamp || 0) - Number(a.timestamp || 0);
    return timestampDiff || b.time.localeCompare(a.time);
  });
  return { items: unique.slice(0, mediaCrawlerConfig.maxItems), files, totalItems: unique.length, connected: Boolean(files.length) };
}

function applyCollectedItems(items, lastUpdated = '', notice = '') {
  state.contents = [...new Map(items.map(item => [item.id, item])).values()].slice(0, 30);
  state.summary.newTrends = new Set(recentItems(state.contents).map(item => item.coreKeyword || item.tags[0]).filter(Boolean)).size;
  state.summary.pendingReview = state.contents.length ? 1 : 0;
  state.review = buildDailyReview(state.contents);
  state.collectionNotice = notice;
  if (!state.contents.length) {
    state.trends = [];
    state.summary.newTrends = 0;
    state.review.subtitle = notice || '本轮暂无符合采集条件的高赞内容。';
    state.review.summary = state.review.subtitle;
    state.agentDigest = { summary: state.review.subtitle, markdown: '', news: [], provider: 'filter-rules', generatedAt: new Date().toISOString() };
  }
  if (lastUpdated) state.lastUpdated = lastUpdated;
}

async function hydrateFromMediaCrawler(platforms = Object.keys(mediaCrawlerConfig.platforms)) {
  const imported = await readMediaCrawlerData(platforms);
  if (!imported.items.length) return imported;
  applyCollectedItems(imported.items, imported.files.sort((a, b) => b.mtime.localeCompare(a.mtime))[0]?.mtime || state.lastUpdated);
  return { ...imported, connected: true };
}

function parseMcpBody(raw, contentType = '') {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { /* Streamable HTTP may return an SSE envelope. */ }
  const dataLine = raw.split('\n').find(line => line.startsWith('data:'));
  if (dataLine) {
    try { return JSON.parse(dataLine.slice(5).trim()); } catch { /* fall through */ }
  }
  throw new Error(`小红书 MCP 返回了无法解析的 ${contentType || '响应'}`);
}

async function postXhsMcp(payload, sessionId = '') {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  if (xhsMcpBearerToken) headers.Authorization = `Bearer ${xhsMcpBearerToken}`;
  const response = await fetch(xhsMcpUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(xhsMcpTimeoutMs) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`小红书 MCP ${response.status}: ${raw.slice(0, 300)}`);
  return { payload: parseMcpBody(raw, response.headers.get('content-type') || ''), sessionId: response.headers.get('mcp-session-id') || sessionId };
}

async function openXhsMcpSession() {
  const init = await postXhsMcp({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'daily-intelligence', version: '1.0.0' } }, id: 1 });
  if (init.payload.error) throw new Error(init.payload.error.message || '小红书 MCP 初始化失败');
  // The current xiaohongshu-mcp release acknowledges this notification but can
  // leave the subsequent search request open; initialize is sufficient here.
  return init.sessionId;
}

async function callXhsMcpTool(sessionId, name, args = {}) {
  const response = await postXhsMcp({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: Date.now() }, sessionId);
  if (response.payload.error) throw new Error(response.payload.error.message || `${name} 调用失败`);
  const text = response.payload.result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '';
  if (/未登录|请使用.*登录|❌/.test(text)) throw new Error('小红书 MCP 未登录，请先完成小红书扫码登录');
  if (!text) return response.payload.result?.structuredContent || response.payload.result || {};
  try { return JSON.parse(text); } catch { return { text }; }
}

async function callXhsMcpRaw(name, args = {}) {
  const sessionId = await openXhsMcpSession();
  const response = await postXhsMcp({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: Date.now() }, sessionId);
  if (response.payload.error) throw new Error(response.payload.error.message || `${name} 调用失败`);
  return response.payload.result?.content || [];
}

async function getXhsLoginStatus() {
  const content = await callXhsMcpRaw('check_login_status');
  const text = content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  return { loggedIn: !/未登录/.test(text) && /已登录|登录成功|logged\s*in/i.test(text), text };
}

function normalizeXhsMcpItem(item, sourceKeyword, collectedAt = Date.now(), coreKeyword = sourceKeyword, topicId = '') {
  const card = item?.noteCard || item?.note_card || {};
  const interact = card.interactInfo || card.interact_info || {};
  const user = card.user || {};
  const cover = card.cover || {};
  const id = String(item?.id || item?.feed_id || item?.note_id || '').trim();
  if (!id) return null;
  const token = String(item?.xsecToken || item?.xsec_token || '').trim();
  const title = String(card.displayTitle || card.display_title || card.title || item?.title || '未命名小红书笔记').trim();
  const author = String(user.nickname || user.nickName || user.user_nickname || '未知作者').trim();
  const type = String(card.type || item?.type || '').toLowerCase() === 'video' ? '视频' : '图文';
  const sourceImage = String(cover.urlDefault || cover.url_default || cover.urlPre || cover.url || item?.cover_url || '').trim().replace(/^http:/, 'https:');
  const url = token ? `https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_search` : `https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}`;
  const tags = parseTags(title, coreKeyword);
  const publishedTimestamp = xhsPublishTimestamp(item, card, id);
  return {
    id,
    sourceId: id,
    title,
    summary: `${author} · ${type} · 搜索词：${sourceKeyword}`,
    tags,
    coreKeyword: coreKeyword || tags[0] || '',
    platform: '小红书',
    time: publishedTimestamp ? formatCrawlerTime(publishedTimestamp) : '发布时间未知',
    timestamp: publishedTimestamp,
    publishedAt: publishedTimestamp ? new Date(publishedTimestamp).toISOString() : '',
    collectedAt: new Date(collectedAt).toISOString(),
    likes: String(interact.likedCount ?? interact.liked_count ?? 0),
    collects: String(interact.collectedCount ?? interact.collected_count ?? 0),
    comments: String(interact.commentCount ?? interact.comment_count ?? 0),
    author,
    image: sourceImage || fallbackImageFor('小红书', id),
    sourceImage,
    url,
    sourceKeyword,
    topicId,
    xsecToken: token,
    source: 'xiaohongshu-mcp'
  };
}

function balanceXhsItemsByTopic(items, specs, maxItems) {
  const topicLabels = new Map();
  specs.forEach(spec => {
    if (spec.topicId) topicLabels.set(spec.topicId, spec.topicLabel || spec.topicId);
  });

  const groups = new Map([...topicLabels.keys()].map(topicId => [topicId, []]));
  const seen = new Set();
  for (const item of items) {
    const topicId = item.topicId || item.coreKeyword || '未分类';
    if (!groups.has(topicId)) groups.set(topicId, []);
    const sourceId = String(item.sourceId || item.id);
    const key = `${topicId}\u0000${sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.get(topicId).push(item);
  }

  groups.forEach(group => group.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)));

  const activeTopics = [...groups.keys()].filter(topicId => groups.get(topicId).length > 0);
  const selected = [];
  const positions = new Map(activeTopics.map(topicId => [topicId, 0]));
  const limit = Math.max(0, Number(maxItems) || 0);

  // Pick one result from every selected topic per round. This prevents a
  // high-volume or later-running keyword from consuming the whole result set.
  while (selected.length < limit) {
    let added = false;
    for (const topicId of activeTopics) {
      const position = positions.get(topicId);
      const next = groups.get(topicId)[position];
      if (!next || selected.length >= limit) continue;
      const sourceId = String(next.sourceId || next.id);
      selected.push({ ...next, sourceId, id: `${sourceId}::${topicId}` });
      positions.set(topicId, position + 1);
      added = true;
    }
    if (!added) break;
  }

  const topicCounts = activeTopics.map(topicId => ({
    topicId,
    topicLabel: topicLabels.get(topicId) || groups.get(topicId)[0]?.coreKeyword || topicId,
    count: selected.filter(item => item.topicId === topicId).length,
    available: groups.get(topicId).length
  }));
  return { items: selected, totalItems: seen.size, topicCounts };
}

async function collectFromXhsMcp(searchSpecs, maxItems) {
  const collectedAt = Date.now();
  const items = [];
  const login = await getXhsLoginStatus();
  if (!login.loggedIn) throw new Error('小红书 MCP 未登录，请先在采集设置中扫码登录');
  const specs = [...new Map(searchSpecs.filter(item => item?.term).map(item => [item.term, item])).values()];
  const collectSpec = async spec => {
    const keyword = spec.term;
    // xiaohongshu-mcp currently keeps a search browser operation attached to
    // one streamable-HTTP session, so isolate each keyword in a fresh session.
    const sessionId = await openXhsMcpSession();
    let result = await callXhsMcpTool(sessionId, 'search_feeds', {
      keyword,
      filters: { sort_by: '最多点赞', publish_time: '半年内' }
    });
    let feeds = Array.isArray(result?.feeds) ? result.feeds : [];
    if (!feeds.length) {
      pushSchedulerLog(`“${keyword}”高赞筛选搜索返回0条，自动回退综合搜索`);
      const fallbackSessionId = await openXhsMcpSession();
      result = await callXhsMcpTool(fallbackSessionId, 'search_feeds', { keyword });
      feeds = Array.isArray(result?.feeds) ? result.feeds : [];
    }
    feeds.forEach(feed => {
      const item = normalizeXhsMcpItem(feed, keyword, collectedAt, spec.topicLabel, spec.topicId);
      if (item) items.push(item);
    });
  };
  for (const spec of specs) await collectSpec(spec);

  // A cold or rate-limited MCP browser can occasionally return an empty first
  // response without throwing. Retry the primary term once for a topic that
  // otherwise produced no content, so one selected theme does not disappear.
  const primarySpecs = [];
  const primaryTopicIds = new Set();
  for (const spec of specs) {
    if (!spec.topicId || primaryTopicIds.has(spec.topicId)) continue;
    primaryTopicIds.add(spec.topicId);
    primarySpecs.push(spec);
  }
  for (const spec of primarySpecs) {
    if (items.some(item => item.topicId === spec.topicId)) continue;
    pushSchedulerLog(`${spec.topicLabel}首次返回 0 条，正在重试主搜索词“${spec.term}”`);
    await collectSpec(spec);
    if (!items.some(item => item.topicId === spec.topicId)) pushSchedulerLog(`${spec.topicLabel}重试后仍为 0 条，本轮不使用其他主题内容替代`);
  }
  // Keep the complete search result pool until the strict recency/likes/
  // relevance gate runs. Limiting by recency here could discard a qualifying
  // high-like post before it is evaluated.
  const balanced = balanceXhsItemsByTopic(items, specs, Math.max(maxItems, items.length));
  return { ...balanced, keywords: specs.map(item => item.term), source: 'xiaohongshu-mcp', url: xhsMcpUrl, collectedAt: new Date(collectedAt).toISOString(), connected: true };
}

function dateStringInTimezone(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: automationConfig.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function twitterSearchWindow() {
  const now = Date.now();
  const windowDays = Math.max(1, Number(automationConfig.collectionWindowDays) || 90);
  return {
    since: dateStringInTimezone(new Date(now - windowDays * 86_400_000)),
    // X's until operator is exclusive, so include tomorrow to cover today's posts.
    until: dateStringInTimezone(new Date(now + 86_400_000))
  };
}

function normalizeTwitterItem(tweet, sourceKeyword, topicLabel, topicId) {
  const id = String(tweet?.id || '').trim();
  if (!id) return null;
  const text = String(tweet.text || '').replace(/\s+/g, ' ').trim();
  const author = tweet.author || {};
  const metrics = tweet.metrics || {};
  const media = Array.isArray(tweet.media) ? tweet.media : [];
  const sourceImage = String(media.find(item => item?.url)?.url || '').trim();
  const createdAt = tweet.createdAtISO || tweet.createdAt || '';
  const timestamp = normalizeTimestamp(createdAt);
  const screenName = String(author.screenName || author.screen_name || '').trim();
  const url = screenName ? `https://x.com/${encodeURIComponent(screenName)}/status/${encodeURIComponent(id)}` : `https://x.com/i/web/status/${encodeURIComponent(id)}`;
  const title = text.split(/(?<=[。！？.!?])\s+/)[0].slice(0, 90) || `${topicLabel || sourceKeyword} · X 热门内容`;
  return {
    id: `${id}::${topicId || sourceKeyword}`,
    sourceId: id,
    title,
    summary: text.slice(0, 180) || title,
    tags: parseTags(text, topicLabel || sourceKeyword),
    coreKeyword: topicLabel || sourceKeyword,
    platform: '推特',
    time: timestamp ? formatCrawlerTime(timestamp) : String(tweet.createdAtLocal || '发布时间未知'),
    timestamp,
    publishedAt: timestamp ? new Date(timestamp).toISOString() : '',
    likes: String(metrics.likes ?? 0),
    collects: String(metrics.bookmarks ?? 0),
    comments: String(metrics.replies ?? 0),
    author: String(author.name || screenName || '未知作者'),
    image: sourceImage || fallbackImageFor('推特', id),
    sourceImage,
    url,
    sourceKeyword,
    topicId,
    source: 'twitter-cli'
  };
}

function parseTwitterCliPayload(raw) {
  const payload = JSON.parse(String(raw || '').trim());
  if (payload?.ok === false) throw new Error(payload.error?.message || 'Twitter CLI 返回错误');
  const data = payload?.ok === true && Array.isArray(payload.data) ? payload.data : payload;
  if (!Array.isArray(data)) throw new Error('Twitter CLI 返回格式无法识别');
  return data;
}

async function collectFromTwitterCli(searchSpecs, maxItems) {
  const specs = [...new Map(searchSpecs.filter(item => item?.term).map(item => [item.term, item])).values()];
  if (!specs.length) return { items: [], keywords: [], source: 'twitter-cli', connected: true };
  const range = twitterSearchWindow();
  const collected = [];
  for (const spec of specs) {
    const args = ['search', spec.term, '--type', 'latest', '--since', range.since, '--until', range.until, '--min-likes', String(automationConfig.minimumLikes), '--max', String(Math.max(1, Number(maxItems) || 1)), '--json'];
    pushSchedulerLog(`推特搜索“${spec.term}”：${range.since} 至 ${range.until}，点赞不少于 ${automationConfig.minimumLikes}`);
    const result = await runTwitterCli(args);
    const tweets = parseTwitterCliPayload(result.stdout);
    tweets.forEach(tweet => {
      const item = normalizeTwitterItem(tweet, spec.term, spec.topicLabel, spec.topicId);
      if (item) collected.push(item);
    });
    pushSchedulerLog(`推特关键词“${spec.term}”返回 ${tweets.length} 条候选数据`);
  }
  return {
    items: [...new Map(collected.map(item => [item.id, item])).values()],
    keywords: specs.map(item => item.term),
    source: 'twitter-cli',
    cliPath: automationConfig.twitterCliPath,
    connected: true
  };
}

async function hydrateFromXhsMcp(imported) {
  if (!imported.items.length) return { ...imported, connected: true };
  applyCollectedItems(imported.items, imported.collectedAt);
  return { ...imported, connected: true };
}

async function persistLatestCollection(items, collectedAt, notice = '') {
  await mkdir(path.dirname(latestCollectionPath), { recursive: true });
  await writeFile(latestCollectionPath, `${JSON.stringify({
    collectedAt,
    collector: automationConfig.collector,
    selectedTracks: automationConfig.selectedTracks,
    collectionWindowDays: 90,
    minimumLikes: 1_000,
    notice,
    items
  }, null, 2)}\n`, 'utf8');
}

async function hydrateLatestCollection() {
  try {
    const saved = JSON.parse(await readFile(latestCollectionPath, 'utf8'));
    const currentTracks = [...automationConfig.selectedTracks].sort();
    const savedTracks = Array.isArray(saved.selectedTracks) ? [...saved.selectedTracks].sort() : [];
    if (saved.collector !== automationConfig.collector || JSON.stringify(savedTracks) !== JSON.stringify(currentTracks) || !Array.isArray(saved.items)) return false;
    const report = qualifyCollectedItems(saved.items);
    const notice = qualificationNotice(report) || String(saved.notice || '');
    applyCollectedItems(report.items, saved.collectedAt || '', notice);
    collectionStatus = { source: saved.collector, url: xhsMcpUrl, items: report.items, totalItems: report.items.length, rawTotalItems: report.rawCount, keywords: expandedKeywords(currentTracks), collectedAt: saved.collectedAt || null, connected: true };
    return true;
  } catch {
    return false;
  }
}

let collectionStatus = { source: 'xiaohongshu-mcp', url: xhsMcpUrl, items: [], totalItems: 0, keywords: [], connected: false };
// When MCP is the configured Xiaohongshu collector, do not resurrect stale
// Xiaohongshu files from a previous MediaCrawler run during server startup.
// MediaCrawler remains available for platforms that still use it (currently
// Douyin) and for the explicit legacy /api/crawler/* endpoints.
const mediaBootstrapPlatforms = automationConfig.collector === 'xiaohongshu-mcp'
  ? Object.keys(mediaCrawlerConfig.platforms).filter(platform => platform !== 'xhs')
  : Object.keys(mediaCrawlerConfig.platforms);
let mediaCrawlerStatus = { source: 'mediacrawler', items: [], totalItems: 0, files: [], connected: false };
if (!(await hydrateLatestCollection())) mediaCrawlerStatus = await hydrateFromMediaCrawler(mediaBootstrapPlatforms);

const schedulerState = {
  running: false,
  currentPlatform: null,
  currentSlot: null,
  lastRunKey: null,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  lastNotice: state.collectionNotice || null,
  log: []
};

function keywordString() {
  return expandedKeywords(automationConfig.selectedTracks).join('、');
}

function selectedTopicString() {
  return keywordCatalog.filter(topic => automationConfig.selectedTracks.includes(topic.id)).map(topic => topic.label).join('、');
}

function compactSchedulerLog(line) {
  const text = String(line || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  // Raw crawler output contains long IDs, comment bodies and aweme_list dumps;
  // keep those in server.log, not in the dashboard activity feed.
  if (/aweme_list:|update_dy_aweme_comment|get_comments\]|Sleeping for \d+ seconds/i.test(text)) return '';
  return text.length > 260 ? `${text.slice(0, 260)}…` : text;
}

function pushSchedulerLog(line) {
  const compact = compactSchedulerLog(line);
  if (!compact) return;
  schedulerState.log = [...schedulerState.log, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${compact}`].slice(-80);
}

function schedulerPublicState() {
  const publicConfig = { ...automationConfig, agentPrompt: undefined, agentConfigured: Boolean(automationConfig.agentPrompt) };
  return {
    ...schedulerState,
    keywords: keywordString(),
    scheduleTimes: automationConfig.scheduleTimes,
    enabledPlatforms: automationConfig.enabledPlatforms,
    platformLabels: Object.fromEntries(Object.entries(collectorPlatforms)),
    collector: automationConfig.collector,
    collectorUrl: xhsMcpUrl,
    keywordCatalog,
    timezone: automationConfig.timezone,
    config: publicConfig
  };
}

function localAgentAnalysis(items) {
  const grouped = new Map();
  for (const item of items) {
    for (const tag of item.tags || []) {
      const entry = grouped.get(tag) || { tag, count: 0, platforms: new Set(), evidenceIds: [] };
      entry.count += 1;
      entry.platforms.add(item.platform);
      if (entry.evidenceIds.length < 3) entry.evidenceIds.push(item.id);
      grouped.set(tag, entry);
    }
  }
  const trends = [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 6).map((entry, index) => ({
    title: `${entry.tag}相关内容升温`,
    insight: `近期开采内容中出现 ${entry.count} 次，覆盖${[...entry.platforms].join('、')}。`,
    platforms: [...entry.platforms],
    change: `+${Math.min(99, entry.count * 12)}%`,
    evidenceIds: entry.evidenceIds,
    rank: index + 1
  }));
  return {
    provider: 'local-rules',
    summary: `本轮共分析 ${items.length} 条内容，识别出 ${trends.length} 个高频主题。`,
    news: items.slice(0, 5).map(item => ({ title: item.title, url: item.url, summary: item.summary, platform: item.platform })),
    trends,
    review: trends[0] ? { title: trends[0].title, subtitle: trends[0].insight, tags: [trends[0].title.replace('相关内容升温', '')] } : null
  };
}

function normalizeAgentAnalysis(raw, items) {
  const news = Array.isArray(raw?.news) ? raw.news.slice(0, 5).map(item => ({
    title: String(item.title || '未命名新闻'),
    url: String(item.url || '#'),
    summary: String(item.summary || ''),
    platform: String(item.platform || '')
  })) : items.slice(0, 5).map(item => ({ title: item.title, url: item.url, summary: item.summary, platform: item.platform }));
  const trends = Array.isArray(raw?.trends) ? raw.trends.slice(0, 6).map((item, index) => ({
    rank: item.rank || index + 1,
    title: String(item.title || '未命名趋势'),
    insight: String(item.insight || item.summary || ''),
    platforms: Array.isArray(item.platforms) ? item.platforms.map(String).slice(0, 3) : [],
    change: String(item.change || '+0%'),
    evidenceIds: Array.isArray(item.evidenceIds) ? item.evidenceIds.map(String).slice(0, 5) : []
  })) : [];
  return {
    provider: String(raw?.provider || 'local-rules'),
    summary: String(raw?.summary || '').slice(0, 100),
    markdown: String(raw?.markdown || ''),
    news,
    trends,
    review: raw?.review && typeof raw.review === 'object' ? raw.review : null
  };
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Agent 返回内容不是 JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function runRemoteAgent(items, prompt = automationConfig.agentPrompt) {
  const baseUrl = process.env.OPENAI_BASE_URL || process.env.AGENT_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY || process.env.AGENT_API_KEY;
  if (!baseUrl || !apiKey) return null;
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: automationConfig.agentModel, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(items.map(item => ({ id: item.id, title: item.title, summary: item.summary, platform: item.platform, time: item.time, tags: item.tags, likes: item.likes, collects: item.collects, comments: item.comments, url: item.url }))) }] })
  });
  if (!response.ok) throw new Error(`Agent API ${response.status}: ${await response.text()}`);
  return { provider: 'remote-agent', ...extractJson(await response.text()) };
}

async function runAgentAnalysisFor(items, prompt = automationConfig.agentPrompt, useRemote = true) {
  let analysis = null;
  if (useRemote && automationConfig.agentProvider !== 'local') {
    try { analysis = await runRemoteAgent(items, prompt); } catch (error) { pushSchedulerLog(`远程 Agent 失败，切换本地规则：${error.message}`); }
  }
  return normalizeAgentAnalysis(analysis || localAgentAnalysis(items), items);
}

async function runAgentAnalysis() {
  if (!automationConfig.agentEnabled || !state.contents.length) return null;
  const analysisItems = recentItems(state.contents);
  if (!analysisItems.length) {
    state.trends = [];
    state.agentDigest = { summary: '近3个月暂无可用采集内容，请先运行一次采集。', markdown: '', news: [], provider: 'local-rules', generatedAt: new Date().toISOString() };
    return null;
  }
  const analysis = await runAgentAnalysisFor(analysisItems);
  const trends = analysis.trends;
  state.trends = trends;
  state.review = buildDailyReview(state.contents, analysis);
  state.summary.newTrends = trends.length;
  state.agentDigest = { summary: analysis.summary, markdown: analysis.markdown, news: analysis.news, provider: analysis.provider, generatedAt: new Date().toISOString() };
  await mkdir(path.dirname(agentResultPath), { recursive: true });
  await writeFile(agentResultPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...analysis }, null, 2)}\n`, 'utf8');
  pushSchedulerLog(`Agent 分析完成：${analysis.provider}，识别 ${trends.length} 个趋势`);
  return analysis;
}

function runChild(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: mediaCrawlerConfig.root, env: { ...process.env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = chunk => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-12000);
      text.split('\n').filter(Boolean).slice(-3).forEach(line => pushSchedulerLog(line));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`MediaCrawler 超过 ${options.timeoutMinutes} 分钟未完成`));
    }, options.timeoutMinutes * 60 * 1000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, output });
      else reject(new Error(`MediaCrawler 退出码 ${code}\n${output.slice(-1200)}`));
    });
  });
}

function runTwitterCli(args) {
  return new Promise((resolve, reject) => {
    const command = automationConfig.twitterCliPath || twitterCliPath;
    const child = spawn(command, args, {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const collectStdout = chunk => { stdout = `${stdout}${chunk.toString()}`.slice(-2_000_000); };
    const collectStderr = chunk => {
      const text = chunk.toString();
      stderr = `${stderr}${text}`.slice(-12_000);
      text.split('\n').filter(Boolean).slice(-3).forEach(line => pushSchedulerLog(`[推特] ${line}`));
    };
    child.stdout.on('data', collectStdout);
    child.stderr.on('data', collectStderr);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`推特 CLI 超过 ${twitterCliTimeoutSeconds} 秒未完成`));
    }, Math.max(30, Number(automationConfig.twitterCliTimeoutSeconds) || twitterCliTimeoutSeconds) * 1000);
    child.on('error', error => { clearTimeout(timer); reject(new Error(`推特 CLI 启动失败：${error.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`推特 CLI 退出码 ${code}${stderr ? `\n${stderr.slice(-1200)}` : ''}`));
    });
  });
}

function startCdpPermissionWatcher() {
  if (process.platform !== 'darwin' || automationConfig.autoAcceptCdpPrompt !== true) return null;
  const watcherPath = path.join(__dirname, 'scripts/cdp_permission_watcher.mjs');
  const timeoutSeconds = Math.max(1, Number(automationConfig.cdpPromptTimeoutSeconds) || 60);
  const child = spawn(process.execPath, [watcherPath, '--timeout-seconds', String(timeoutSeconds)], {
    cwd: __dirname,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let closed = false;
  let resolveStop = null;
  child.stdout.on('data', chunk => chunk.toString().split('\n').filter(Boolean).forEach(line => pushSchedulerLog(line)));
  child.stderr.on('data', chunk => chunk.toString().split('\n').filter(Boolean).forEach(line => pushSchedulerLog(`[cdp-permission] ${line}`)));
  child.on('error', error => pushSchedulerLog(`[cdp-permission] watcher unavailable: ${error.message}`));
  child.on('close', () => { closed = true; if (resolveStop) resolveStop(); });
  pushSchedulerLog('已启动 Chrome 远程调试授权监听器');
  return {
    stop: () => new Promise(resolve => {
      if (closed) return resolve();
      resolveStop = resolve;
      child.kill('SIGTERM');
      setTimeout(() => { if (!closed) resolve(); }, 1500);
    })
  };
}

if (state.contents.length) await runAgentAnalysis();

function localClock() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: automationConfig.timezone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

async function runCollectionCycle(platforms = automationConfig.enabledPlatforms, slot = 'manual') {
  if (schedulerState.running) return { ok: false, error: 'collection_already_running' };
  const selectedPlatforms = (Array.isArray(platforms) ? platforms : []).filter(platform => collectorPlatforms[platform]);
  if (!selectedPlatforms.length) return { ok: false, error: 'no_enabled_platform' };
  schedulerState.running = true;
  schedulerState.currentSlot = slot;
  schedulerState.lastError = null;
  schedulerState.lastNotice = null;
  schedulerState.lastResult = null;
  schedulerState.log = [];
  let cdpPermissionWatcher = null;
  try {
    const useXhsMcp = automationConfig.collector === 'xiaohongshu-mcp' && selectedPlatforms.includes('xhs');
    const useTwitterCli = selectedPlatforms.includes('twitter');
    const mediaPlatforms = selectedPlatforms.filter(platform => platform !== 'twitter' && !(useXhsMcp && platform === 'xhs'));
    const searchSpecs = selectedSearchSpecs(automationConfig.selectedTracks);
    const keywords = searchSpecs.map(item => item.term);
    const collected = [];
    if (useXhsMcp) {
      schedulerState.currentPlatform = 'xhs';
      pushSchedulerLog(`开始采集：小红书 MCP；搜索按最多点赞排序并限制半年内，后端仅保留近3个月、点赞>1000且与主题相关的内容；关注主题：${selectedTopicString()}；扩展搜索词：${keywordString()}`);
      const imported = await collectFromXhsMcp(searchSpecs, automationConfig.maxNotes);
      collected.push(...imported.items);
      const topicCountText = imported.topicCounts.map(topic => `${topic.topicLabel} ${topic.count} 条`).join('，');
      pushSchedulerLog(`小红书 MCP 搜索完成，共取得 ${imported.items.length} 条候选数据${topicCountText ? `（${topicCountText}）` : ''}，正在执行高赞筛选`);
    } else {
      collectionStatus = { source: 'mediacrawler', url: mediaCrawlerConfig.root, items: [], totalItems: 0, keywords: keywords, connected: false };
    }

    if (useTwitterCli) {
      schedulerState.currentPlatform = 'twitter';
      pushSchedulerLog(`开始采集：推特 CLI；仅搜索当前选中的主题和扩展搜索词：${keywordString()}`);
      const imported = await collectFromTwitterCli(searchSpecs, automationConfig.maxNotes);
      collected.push(...imported.items);
      pushSchedulerLog(`推特 CLI 搜索完成，共取得 ${imported.items.length} 条候选数据，正在执行统一筛选`);
    }

    if (mediaPlatforms.length) {
      cdpPermissionWatcher = startCdpPermissionWatcher();
      pushSchedulerLog(`开始采集：${mediaPlatforms.map(platform => mediaCrawlerConfig.platforms[platform]).join('、')}；关注主题：${selectedTopicString()}；扩展搜索词：${keywordString()}`);
      for (const platform of mediaPlatforms) {
        schedulerState.currentPlatform = platform;
        const runnerPrefix = automationConfig.runner.endsWith('/uv') || automationConfig.runner === 'uv' ? ['run'] : [];
        const args = [...runnerPrefix, automationConfig.runnerScript, '--platform', platform, '--lt', automationConfig.loginType, '--type', 'search', '--keywords', keywordString(), '--save_data_option', 'json', '--save_data_path', automationConfig.saveDataPath, '--crawler_max_notes_count', String(automationConfig.maxNotes), '--get_comment', String(automationConfig.getComments), '--headless', String(automationConfig.headless)];
        pushSchedulerLog(`启动 ${mediaCrawlerConfig.platforms[platform]} MediaCrawler`);
        await runChild(automationConfig.runner, args, { timeoutMinutes: automationConfig.timeoutMinutes });
        pushSchedulerLog(`${mediaCrawlerConfig.platforms[platform]} 采集完成`);
      }
      mediaCrawlerStatus = await readMediaCrawlerData(mediaPlatforms);
      collected.push(...mediaCrawlerStatus.items);
    }

    const uniqueCandidates = [...new Map(collected.map(item => [item.id, item])).values()];
    const qualification = qualifyCollectedItems(uniqueCandidates);
    const notice = qualificationNotice(qualification);
    qualification.topicCounts.filter(topic => topic.count === 0).forEach(topic => pushSchedulerLog(noQualifiedContentNotice([topic.topicLabel])));
    pushSchedulerLog(`筛选完成：候选 ${qualification.rawCount} 条，保留 ${qualification.items.length} 条；超出3个月 ${qualification.rejected.outsideWindow} 条，点赞未超过1000 ${qualification.rejected.belowMinimumLikes} 条，关键词相关性不足 ${qualification.rejected.unrelated} 条`);
    pushSchedulerLog(`近3个月且关键词相关内容的点赞分布：≤1000 ${qualification.likeDistribution.upTo1000} 条，1001–5000 ${qualification.likeDistribution.between1000And5000} 条，5001–10000 ${qualification.likeDistribution.between5000And10000} 条，10001–40000 ${qualification.likeDistribution.between10000And40000} 条，>40000 ${qualification.likeDistribution.above40000} 条`);
    if (notice) {
      schedulerState.lastNotice = notice;
      pushSchedulerLog(`提示：${notice}`);
    }
    const collectedAt = new Date().toISOString();
    applyCollectedItems(qualification.items, collectedAt, notice);
    await persistLatestCollection(qualification.items, state.lastUpdated, notice);
    if (qualification.items.length) await runAgentAnalysis();
    const sources = [];
    if (useXhsMcp) sources.push('xiaohongshu-mcp');
    if (mediaPlatforms.length) sources.push('mediacrawler');
    if (useTwitterCli) sources.push('twitter-cli');
    const source = sources.join('+');
    const urls = [];
    if (useXhsMcp) urls.push(xhsMcpUrl);
    if (mediaPlatforms.length) urls.push(mediaCrawlerConfig.root);
    if (useTwitterCli) urls.push(automationConfig.twitterCliPath);
    collectionStatus = { source, url: urls.join('、'), items: qualification.items, totalItems: qualification.items.length, rawTotalItems: qualification.rawCount, keywords, collectedAt, connected: true };
    schedulerState.lastResult = { imported: qualification.items.length, totalItems: qualification.items.length, rawScanned: qualification.rawCount, likeDistribution: qualification.likeDistribution, source, notice };
    schedulerState.lastRunAt = new Date().toISOString();
    return { ok: true, ...schedulerState.lastResult };
  } catch (error) {
    schedulerState.lastError = error.message;
    schedulerState.lastRunAt = new Date().toISOString();
    pushSchedulerLog(`采集失败：${error.message.split('\n')[0]}`);
    return { ok: false, error: error.message };
  } finally {
    if (cdpPermissionWatcher) await cdpPermissionWatcher.stop();
    schedulerState.running = false;
    schedulerState.currentPlatform = null;
    schedulerState.currentSlot = null;
  }
}

async function scheduleTick() {
  if (schedulerState.running) return;
  const clock = localClock();
  if (!automationConfig.scheduleTimes.includes(clock.time)) return;
  const runKey = `${clock.date} ${clock.time}`;
  if (schedulerState.lastRunKey === runKey) return;
  schedulerState.lastRunKey = runKey;
  await runCollectionCycle(automationConfig.enabledPlatforms, runKey);
}

setInterval(scheduleTick, 20_000);
scheduleTick();

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendBuffer(res, status, body, contentType) {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function normalizeItem(item, index = 0) {
  const tags = Array.isArray(item.tags) ? item.tags.map(String).filter(Boolean).slice(0, 5) : [];
  const timestamp = normalizeTimestamp(item.timestamp || item.publishedAt || item.time);
  return {
    id: String(item.id || `crawler-${Date.now()}-${index}`),
    title: String(item.title || '未命名内容'),
    summary: String(item.summary || item.description || ''),
    tags,
    coreKeyword: String(item.coreKeyword || item.sourceKeyword || item.source_keyword || tags[0] || ''),
    platform: String(item.platform || '未知平台'),
    time: String(item.time || item.publishedAt || '刚刚'),
    timestamp,
    publishedAt: timestamp ? new Date(timestamp).toISOString() : '',
    likes: String(item.likes ?? 0),
    collects: String(item.collects ?? item.favorites ?? 0),
    comments: String(item.comments ?? 0),
    image: String(item.image || fallbackImageFor(item.platform, item.id || index)),
    sourceImage: String(item.sourceImage || item.image || ''),
    url: String(item.url || item.sourceUrl || '#'),
    sourceKeyword: String(item.sourceKeyword || item.source_keyword || '')
  };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) req.destroy(new Error('payload too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

async function proxyXhsMcp(req, res) {
  const payload = await parseJsonBody(req);
  const headers = {
    'Content-Type': 'application/json',
    Accept: req.headers.accept || 'application/json, text/event-stream'
  };
  if (req.headers['mcp-session-id']) headers['Mcp-Session-Id'] = req.headers['mcp-session-id'];
  if (xhsMcpBearerToken) headers.Authorization = `Bearer ${xhsMcpBearerToken}`;
  const upstream = await fetch(xhsMcpUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(xhsMcpTimeoutMs) });
  const responseHeaders = { 'Content-Type': upstream.headers.get('content-type') || 'application/json' };
  const sessionId = upstream.headers.get('mcp-session-id');
  if (sessionId) responseHeaders['Mcp-Session-Id'] = sessionId;
  res.writeHead(upstream.status, responseHeaders);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

async function serveCrawlerMedia(req, res, pathname) {
  const match = pathname.match(/^\/api\/crawler-media\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match) return sendText(res, 404, 'Not found');
  let crawlerPlatform;
  let id;
  let name;
  try {
    crawlerPlatform = decodeURIComponent(match[1]);
    id = decodeURIComponent(match[2]);
    name = decodeURIComponent(match[3]);
  } catch {
    return sendText(res, 400, 'Bad media path');
  }
  if (!mediaCrawlerConfig.platforms[crawlerPlatform] || name.includes('/') || name.includes('\\')) return sendText(res, 400, 'Bad media path');
  for (const root of mediaDataRoots()) {
    const mediaDir = path.resolve(root, crawlerDataDir(crawlerPlatform), 'images', id);
    const filePath = path.resolve(mediaDir, name);
    if (!filePath.startsWith(`${mediaDir}${path.sep}`)) continue;
    try {
      const body = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      return res.end(body);
    } catch { /* try the next data root */ }
  }
  return sendText(res, 404, 'Not found');
}

async function serveReviewItemImage(res, pathname) {
  const encodedId = pathname.slice('/api/review/item-image/'.length);
  let id;
  try { id = decodeURIComponent(encodedId); } catch { return sendText(res, 400, 'Bad image id'); }
  const item = state.contents.find(content => String(content.id) === id);
  if (!item) return sendText(res, 404, 'Image not found');
  const source = String(item.sourceImage || item.image || '');
  if (source.startsWith('/')) {
    const filePath = path.resolve(publicDir, source.replace(/^\/+/, ''));
    if (!filePath.startsWith(publicDir)) return sendText(res, 403, 'Forbidden');
    try {
      const body = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
      return sendBuffer(res, 200, body, types[ext] || 'application/octet-stream');
    } catch { return sendText(res, 404, 'Image not found'); }
  }
  let remote;
  try {
    remote = new URL(source);
    if (!['http:', 'https:'].includes(remote.protocol)) throw new Error('unsupported protocol');
  } catch { return sendText(res, 400, 'Bad image source'); }
  try {
    const upstream = await fetch(remote, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: item.platform === '小红书' ? 'https://www.xiaohongshu.com/' : remote.origin },
      signal: AbortSignal.timeout(15_000)
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !contentType.startsWith('image/')) return sendText(res, 502, 'Image upstream failed');
    return sendBuffer(res, 200, Buffer.from(await upstream.arrayBuffer()), contentType);
  } catch {
    return sendText(res, 502, 'Image upstream failed');
  }
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(publicDir)) return sendText(res, 403, 'Forbidden');
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    sendText(res, 200, body, types[ext] || 'application/octet-stream');
  } catch {
    sendText(res, 404, 'Not found');
  }
}

function isPublicApiPath(pathname) {
  return pathname === '/api/health' || pathname === '/api/auth/status' || pathname === '/api/auth/login' || pathname === '/api/auth/logout';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/auth/status' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, required: Boolean(adminPassword), authenticated: isAuthenticated(req) });
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      if (!adminPassword) return sendJson(res, 200, { ok: true, required: false, authenticated: true, message: 'ADMIN_PASSWORD 未配置，当前为本机开发模式' });
      const payload = await parseJsonBody(req);
      if (!passwordMatches(payload.password)) return sendJson(res, 401, { ok: false, error: 'invalid_password' });
      const token = randomBytes(32).toString('hex');
      adminSessions.set(token, Date.now() + adminSessionTtlMs);
      return sendJson(res, 200, { ok: true, required: true, authenticated: true }, { 'Set-Cookie': authCookie(token, req) });
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = parseCookies(req)[adminSessionCookie];
      if (token) adminSessions.delete(token);
      return sendJson(res, 200, { ok: true, authenticated: false }, { 'Set-Cookie': `${adminSessionCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
    }
    if (url.pathname.startsWith('/api/') && !isPublicApiPath(url.pathname) && !isAuthenticated(req)) {
      return sendJson(res, 401, { ok: false, error: 'authentication_required' });
    }
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, crawlerAdapter: automationConfig.collector, collector: automationConfig.collector, collectorUrl: xhsMcpUrl, connected: collectionStatus.connected, mediaCrawlerCompatibility: mediaCrawlerStatus.connected, time: new Date().toISOString() });
    if (url.pathname === '/api/xhs-mcp' && req.method === 'POST') return proxyXhsMcp(req, res);
    if (url.pathname === '/api/collector/status' && req.method === 'GET') return sendJson(res, 200, { ok: true, source: collectionStatus.source, url: collectionStatus.url, connected: collectionStatus.connected, totalItems: collectionStatus.totalItems, rawTotalItems: collectionStatus.rawTotalItems || collectionStatus.totalItems, keywords: collectionStatus.keywords, collectedAt: collectionStatus.collectedAt || null, policy: { collectionWindowDays: 90, minimumLikes: 1_000, minimumLikesExclusive: true, keywordRelevanceRequired: true }, scheduler: schedulerPublicState() });
    if (url.pathname === '/api/xhs/login-status' && req.method === 'GET') {
      try {
        const status = await getXhsLoginStatus();
        return sendJson(res, 200, { ok: true, loggedIn: status.loggedIn });
      } catch (error) {
        return sendJson(res, 502, { ok: false, loggedIn: false, error: error.message });
      }
    }
    if (url.pathname === '/api/xhs/login-qrcode' && req.method === 'POST') {
      const content = await callXhsMcpRaw('get_login_qrcode');
      const image = content.find(item => item.type === 'image' && item.data);
      const message = content.find(item => item.type === 'text')?.text || '请使用小红书 App 扫码登录';
      if (!image) return sendJson(res, 502, { ok: false, error: '二维码生成失败' });
      return sendJson(res, 200, { ok: true, message, image: `data:${image.mimeType || 'image/png'};base64,${image.data}` });
    }
    if (url.pathname === '/api/crawler/status' && req.method === 'GET') return sendJson(res, 200, { ok: true, source: 'mediacrawler', url: mediaCrawlerConfig.root, connected: mediaCrawlerStatus.connected, totalItems: mediaCrawlerStatus.totalItems, files: mediaCrawlerStatus.files, scheduler: schedulerPublicState(), collector: collectionStatus });
    if (url.pathname === '/api/review/image.svg' && req.method === 'GET') return sendText(res, 200, createReviewSvg(), 'image/svg+xml; charset=utf-8');
    if (url.pathname === '/api/review/image.png' && req.method === 'GET') {
      if (!state.review.approvedImagePath) return sendText(res, 404, 'Approved image not found');
      try { return sendBuffer(res, 200, await readFile(state.review.approvedImagePath), 'image/png'); } catch { return sendText(res, 404, 'Approved image not found'); }
    }
    if (url.pathname.startsWith('/api/review/item-image/') && req.method === 'GET') return serveReviewItemImage(res, url.pathname);
    if (url.pathname === '/api/automation' && req.method === 'GET') return sendJson(res, 200, schedulerPublicState());
    if (url.pathname === '/api/agent/test' && req.method === 'POST') {
      const payload = await parseJsonBody(req);
      const prompt = String(payload.prompt || '').trim();
      if (!prompt) return sendJson(res, 400, { ok: false, error: 'prompt_required' });
      const sampleItems = state.contents.length ? state.contents : seedState.contents;
      const analysis = await runAgentAnalysisFor(sampleItems, prompt, false);
      const checks = {
        summaryUnder100: analysis.summary.length <= 100,
        topFiveNews: analysis.news.length <= 5,
        structuredTrends: Array.isArray(analysis.trends),
        linksPresent: analysis.news.every(item => typeof item.url === 'string')
      };
      return sendJson(res, 200, { ok: Object.values(checks).every(Boolean), dryRun: true, provider: analysis.provider, sampleCount: sampleItems.length, checks, preview: { summary: analysis.summary, news: analysis.news, trends: analysis.trends, review: analysis.review } });
    }
    if (url.pathname === '/api/automation/topics' && req.method === 'POST') {
      const payload = await parseJsonBody(req);
      const label = String(payload.label || '').trim().slice(0, 20);
      const related = cleanKeywordList(payload.keywords, 7).filter(term => term !== label && term.length <= 30);
      if (!label) return sendJson(res, 400, { ok: false, error: '请输入主题名称' });
      if (keywordCatalog.some(topic => topic.label.toLowerCase() === label.toLowerCase())) return sendJson(res, 409, { ok: false, error: '该主题已存在' });
      const topic = {
        id: `custom-${Date.now()}`,
        label,
        description: String(payload.description || `${label}相关内容`).trim().slice(0, 60),
        keywords: [label, ...related].slice(0, 8),
        builtin: false
      };
      keywordCatalog = [...keywordCatalog, topic];
      automationConfig.selectedTracks = [...new Set([...automationConfig.selectedTracks, topic.id])];
      automationConfig.keywords = expandedKeywords(automationConfig.selectedTracks);
      await Promise.all([saveKeywordCatalog(), saveAutomationConfig()]);
      return sendJson(res, 201, { ok: true, topic, ...schedulerPublicState() });
    }
    if (url.pathname === '/api/automation/config' && req.method === 'POST') {
      const payload = await parseJsonBody(req);
      const cleanList = value => Array.isArray(value) ? [...new Set(value.map(item => String(item).trim()).filter(Boolean))].slice(0, 50) : [];
      const scheduleTimes = cleanList(payload.scheduleTimes).filter(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
      const enabledPlatforms = cleanList(payload.enabledPlatforms).filter(value => Object.hasOwn(collectorPlatforms, value));
      const selectedTracks = cleanList(payload.selectedTracks).filter(value => keywordCatalog.some(topic => topic.id === value));
      if (!selectedTracks.length) return sendJson(res, 400, { ok: false, error: '至少选择一个关注主题' });
      automationConfig = {
        ...automationConfig,
        keywords: expandedKeywords(selectedTracks),
        selectedTracks,
        scheduleTimes: scheduleTimes.length ? scheduleTimes.sort() : automationConfig.scheduleTimes,
        enabledPlatforms: enabledPlatforms.length ? enabledPlatforms : automationConfig.enabledPlatforms,
        maxNotes: Math.min(100, Math.max(1, Number(payload.maxNotes || automationConfig.maxNotes))),
        collectionWindowDays: 90,
        minimumLikes: 1_000,
        collector: payload.collector === 'mediacrawler' ? 'mediacrawler' : (automationConfig.collector || 'xiaohongshu-mcp'),
        xhsMcpUrl
      };
      await saveAutomationConfig();
      return sendJson(res, 200, { ok: true, ...schedulerPublicState() });
    }
    if (url.pathname === '/api/automation/run' && req.method === 'POST') {
      if (schedulerState.running) return sendJson(res, 409, { ok: false, error: 'collection_already_running', scheduler: schedulerPublicState() });
      void runCollectionCycle(automationConfig.enabledPlatforms, 'manual');
      return sendJson(res, 202, { ok: true, message: 'collection_started', scheduler: schedulerPublicState() });
    }
    if (url.pathname === '/api/collector/sync' && req.method === 'POST') {
      if (schedulerState.running) return sendJson(res, 409, { ok: false, error: 'collection_already_running', scheduler: schedulerPublicState() });
      const synced = await runCollectionCycle(automationConfig.enabledPlatforms, 'manual-sync');
      if (!synced.ok) return sendJson(res, 502, synced);
      return sendJson(res, 200, { ok: true, source: synced.source, connected: collectionStatus.connected, imported: synced.imported, totalItems: synced.totalItems, lastUpdated: state.lastUpdated });
    }
    if (url.pathname === '/api/crawler/sync' && req.method === 'POST') {
      mediaCrawlerStatus = await hydrateFromMediaCrawler();
      if (mediaCrawlerStatus.items.length) await runAgentAnalysis();
      return sendJson(res, 200, { ok: true, connected: mediaCrawlerStatus.connected, imported: mediaCrawlerStatus.items.length, totalItems: mediaCrawlerStatus.totalItems, lastUpdated: state.lastUpdated });
    }
    if (url.pathname.startsWith('/api/crawler-media/') && req.method === 'GET') return serveCrawlerMedia(req, res, url.pathname);
    if (url.pathname === '/api/dashboard' && req.method === 'GET') return sendJson(res, 200, { ...state, trends: state.trends });
    if (url.pathname === '/api/trends' && req.method === 'GET') {
      const platform = url.searchParams.get('platform') || '全部';
      const trends = platform === '全部' ? state.trends : state.trends.filter(item => item.platforms.includes(platform));
      return sendJson(res, 200, { trends, platform });
    }
    if (url.pathname === '/api/review/approve' && req.method === 'POST') {
      if (!state.review.items?.length) return sendJson(res, 409, { ok: false, error: '本轮暂无符合条件的高赞内容，不能审核或分发' });
      const payload = await parseJsonBody(req);
      const imageMatch = String(payload.imageDataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
      if (!imageMatch) return sendJson(res, 400, { ok: false, error: '请先生成一图流 PNG 再审核' });
      const png = Buffer.from(imageMatch[1], 'base64');
      if (!png.length || png.length > 1_800_000) return sendJson(res, 400, { ok: false, error: '一图流 PNG 文件无效或过大' });
      await mkdir(reviewImageDir, { recursive: true });
      const approvedImagePath = path.join(reviewImageDir, `${state.review.id.replace(/[^a-z0-9-]/gi, '-')}.png`);
      await writeFile(approvedImagePath, png);
      const approvedAt = new Date().toISOString();
      const dispatch = {
        wechat: state.channels.wechat === '待配置' ? 'configuration-required' : 'queued',
        enterpriseWechat: state.channels.enterpriseWechat === '待配置' ? 'configuration-required' : 'queued',
        feishu: state.channels.feishu === '待配置' ? 'configuration-required' : 'queued',
        miniProgram: 'subscription-required'
      };
      state.review.status = 'approved';
      state.review.approvedAt = approvedAt;
      state.review.approvedImagePath = approvedImagePath;
      state.review.approvedImageUrl = `/api/review/image.png?v=${encodeURIComponent(approvedAt)}`;
      state.review.image = state.review.approvedImageUrl;
      state.review.sourceUrl = state.review.approvedImageUrl;
      state.review.dispatch = dispatch;
      state.summary.pendingReview = Math.max(0, state.summary.pendingReview - 1);
      state.summary.todayPushed = '3/3';
      pushSchedulerLog(`一图流已审核并锁定 PNG；微信、企业微信、飞书进入分发检查`);
      return sendJson(res, 200, { ok: true, review: state.review, summary: state.summary, dispatch });
    }
    if (url.pathname === '/api/crawler/ingest' && req.method === 'POST') {
      if (!crawlerToken || req.headers['x-crawler-token'] !== crawlerToken) return sendJson(res, 401, { ok: false, error: 'crawler_token_invalid' });
      const payload = await parseJsonBody(req);
      const items = Array.isArray(payload.items) ? payload.items.map(normalizeItem) : [];
      state.contents = [...items, ...state.contents].slice(0, 30);
      state.summary.newTrends += Number(payload.newTrends || 0);
      state.lastUpdated = '刚刚';
      return sendJson(res, 202, { ok: true, accepted: items.length, lastUpdated: state.lastUpdated });
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, host, () => console.log(`每日情报 MVP running at http://${host}:${port}`));
