const MCP_URL = '/api/xhs-mcp';
const state = { sessionId: '', connected: false, tools: [], selectedImage: '/assets/thumb-camp.svg' };
const detailCache = new Map();
const detailRequests = new Map();
const $ = selector => document.querySelector(selector);

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function showToast(message) {
  const toast = $('#xhsToast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function setConnectionStatus(status, detail = '') {
  const dot = $('#sidebarStatusDot');
  const label = $('#sidebarStatusText');
  const metric = $('#metricStatus');
  const tools = $('#metricTools');
  const pill = $('#metricPill');
  const accountState = $('#accountState');
  const accountDescription = $('#accountDescription');
  dot.className = `xhs-status-dot ${status}`;
  if (status === 'connected') {
    label.textContent = '已连接';
    metric.textContent = '已连接';
    metric.style.color = '#47a86e';
    tools.textContent = `${state.tools.length || 18} 个工具可用`;
    pill.innerHTML = '<i></i> Local';
    accountState.innerHTML = '<i></i> 可检查';
    accountState.style.color = '#62ad7b';
    accountDescription.textContent = 'MCP 已就绪，可以检查登录状态';
  } else if (status === 'error') {
    label.textContent = '未连接';
    metric.textContent = '未连接';
    metric.style.color = '#d27d83';
    tools.textContent = detail || '请确认 MCP 服务已启动';
    pill.innerHTML = '<i></i> Offline';
    pill.style.color = '#c38289';
    pill.style.background = '#fff0f1';
    accountState.innerHTML = '<i></i> 不可用';
    accountState.style.color = '#d27d83';
    accountDescription.textContent = '暂时无法连接到本地 MCP 服务';
  } else {
    label.textContent = '检测中';
    metric.textContent = '连接中';
    metric.style.color = '#d49a63';
    tools.textContent = '等待服务响应';
    accountState.innerHTML = '<i></i> 检测中';
    accountState.style.color = '#d49a63';
    accountDescription.textContent = '正在检查小红书登录状态';
  }
}

async function requestMcp(method, params = {}, options = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (state.sessionId) headers['Mcp-Session-Id'] = state.sessionId;
  const payload = { jsonrpc: '2.0', method, params };
  if (!method.startsWith('notifications/')) payload.id = Date.now();
  const response = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`MCP ${response.status}`);
  const sessionId = response.headers.get('Mcp-Session-Id');
  if (sessionId) state.sessionId = sessionId;
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    const dataLine = text.split('\n').find(line => line.startsWith('data:'));
    return dataLine ? JSON.parse(dataLine.slice(5).trim()) : {};
  }
}

async function connectMcp(showMessage = true) {
  setConnectionStatus('pending');
  try {
    const init = await requestMcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'xiaohongshu-preview', version: '0.1.0' } });
    if (init.error) throw new Error(init.error.message || 'initialize failed');
    const listed = await requestMcp('tools/list');
    state.tools = listed.result?.tools || [];
    state.connected = true;
    setConnectionStatus('connected');
    void syncLoginBadge(true);
    if (showMessage) showToast(`MCP 已连接 · ${state.tools.length || 18} 个工具可用`);
  } catch (error) {
    state.connected = false;
    setConnectionStatus('error', '请确认服务已启动');
    if (showMessage) showToast('连接失败，请确认 localhost:18060 正在运行');
  }
}

async function callTool(name, argumentsValue = {}) {
  if (!state.connected) await connectMcp(false);
  if (!state.connected) throw new Error('MCP unavailable');
  const result = await requestMcp('tools/call', { name, arguments: argumentsValue });
  if (result.error) throw new Error(result.error.message || 'tool failed');
  return result.result;
}

function updateTitleCount() { $('#titleCount').textContent = `${$('#noteTitle').value.length} / 20`; }

function openPreview() {
  $('#previewModalTitle').textContent = $('#noteTitle').value.trim() || '未命名笔记';
  $('#previewModalCopy').textContent = $('#noteContent').value.trim() || '还没有写下内容。';
  $('#previewImage').src = state.selectedImage;
  $('#previewModalTags').innerHTML = [...document.querySelectorAll('.xhs-tag.active')].map(tag => `<span>${tag.textContent}</span>`).join('');
  $('#previewModal').hidden = false;
}

function closePreview() { $('#previewModal').hidden = true; }

async function checkLogin() {
  const button = $('#checkLogin');
  button.disabled = true;
  button.textContent = '检查中…';
  const loggedIn = await syncLoginBadge(false);
  showToast(loggedIn ? '小红书账号已登录' : '账号尚未登录');
  button.disabled = false;
  button.innerHTML = '检查登录状态 <span>↗</span>';
}

async function syncLoginBadge(silent = true) {
  try {
    const result = await callTool('check_login_status');
    const text = result?.content?.map(item => item.text || '').join(' ') || '';
    const loggedIn = /true|已登录|登录成功|logged/i.test(text);
    $('#accountState').innerHTML = `<i></i> ${loggedIn ? '已登录' : '待登录'}`;
    $('#accountState').style.color = loggedIn ? '#62ad7b' : '#d49a63';
    $('#accountDescription').textContent = loggedIn ? '账号已准备好，可以开始运营' : '请先运行登录工具完成扫码';
    return loggedIn;
  } catch {
    if (!silent) showToast('登录状态检查失败');
    return false;
  }
}

function parseToolResult(result) {
  const text = result?.content?.map(item => item.text || '').filter(Boolean).join('\n') || '';
  if (!text) return result?.structuredContent || result?.data || result || {};
  try { return JSON.parse(text); } catch { return { text }; }
}

function firstValue(item, keys, fallback = '') {
  for (const key of keys) {
    const value = item?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return fallback;
}

function noteCardOf(item) { return item?.noteCard || item?.note_card || item || {}; }

function formatDateTime(value) {
  if (value === undefined || value === null || value === '') return '—';
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatCount(value) {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

function noteImages(note) {
  const images = Array.isArray(note?.imageList) ? note.imageList : Array.isArray(note?.image_list) ? note.image_list : [];
  return images.map(image => firstValue(image, ['urlDefault', 'url_default', 'urlPre', 'url'], '')).filter(Boolean);
}

function detailCacheKey(feedId, xsecToken) { return `${feedId}::${xsecToken || ''}`; }

async function fetchFeedDetail(feedId, xsecToken) {
  const key = detailCacheKey(feedId, xsecToken);
  if (detailCache.has(key)) return detailCache.get(key);
  if (detailRequests.has(key)) return detailRequests.get(key);
  const request = callTool('get_feed_detail', { feed_id: feedId, xsec_token: xsecToken })
    .then(parseToolResult)
    .then(payload => { detailCache.set(key, payload); return payload; })
    .finally(() => detailRequests.delete(key));
  detailRequests.set(key, request);
  return request;
}

function detailNoteOf(payload) {
  const data = payload?.data || payload || {};
  return { data, note: data?.note || data?.noteCard || data?.note_card || {}, comments: data?.comments?.list || data?.comments?.comments || data?.commentList || data?.comment_list || [] };
}

function updateResultCard(row, payload) {
  const { note } = detailNoteOf(payload);
  const time = firstValue(note, ['time', 'createTime', 'create_time', 'publishedAt', 'published_at'], '');
  const type = firstValue(note, ['type'], '') === 'video' || note?.video ? '视频' : '图文';
  const summary = row.querySelector('[data-result-summary]');
  const meta = row.querySelector('[data-result-meta]');
  if (summary && summary.dataset.hasSummary !== 'true') summary.textContent = time ? `发布时间：${formatDateTime(time)}` : '发布时间暂不可用';
  if (meta) meta.textContent = `${type}${time ? ` · ${formatDateTime(time)}` : ''}`;
}

async function enrichResultCards(rows) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      if (!row.dataset.feedId) continue;
      try { updateResultCard(row, await fetchFeedDetail(row.dataset.feedId, row.dataset.xsecToken)); } catch { /* card remains usable when detail enrichment fails */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

function findArray(value, preferredKeys = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of preferredKeys) if (Array.isArray(value[key])) return value[key];
  for (const child of Object.values(value)) {
    const found = findArray(child, preferredKeys);
    if (found.length) return found;
  }
  return [];
}

function renderActionResults(action, payload) {
  const results = $('#actionResults');
  if (action === 'notifications') {
    const source = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    const counts = Object.entries(source || {}).filter(([, value]) => typeof value === 'number' || (value && typeof value === 'object' && typeof value.count === 'number'));
    if (counts.length) {
      results.innerHTML = counts.slice(0, 6).map(([key, value]) => `<div class="xhs-count-row"><span>${escapeHtml(key.replaceAll('_', ' · '))}</span><strong>${escapeHtml(typeof value === 'number' ? value : value.count)}</strong></div>`).join('');
    } else {
      results.innerHTML = '<div class="xhs-action-empty">暂时没有新的通知</div>';
    }
    return;
  }
  const items = findArray(payload, ['feeds', 'notes', 'items', 'data']).slice(0, 8);
  if (!items.length) {
    results.innerHTML = '<div class="xhs-action-empty">没有找到可展示的内容，可能需要先登录小红书账号。</div>';
    return;
  }
  results.innerHTML = items.map((item, index) => {
    const card = noteCardOf(item);
    const interact = card.interactInfo || card.interact_info || {};
    const cover = card.cover || {};
    const title = firstValue(card, ['displayTitle', 'display_title', 'title', 'desc', 'description'], firstValue(item, ['title', 'note_title'], `小红书内容 ${index + 1}`));
    const summary = firstValue(card, ['desc', 'description', 'content'], firstValue(item, ['desc', 'description', 'content'], ''));
    const image = firstValue(cover, ['urlDefault', 'url_default', 'urlPre', 'url'], firstValue(item, ['cover_url', 'image', 'thumbnail'], index % 2 ? '/assets/thumb-skincare.svg' : '/assets/thumb-camp.svg'));
    const comments = firstValue(interact, ['commentCount', 'comment_count', 'comments'], '—');
    const likes = firstValue(interact, ['likedCount', 'liked_count', 'likeCount', 'like_count', 'likes'], '—');
    const collects = firstValue(interact, ['collectedCount', 'collected_count', 'collectCount', 'collect_count', 'favorites'], '—');
    const feedId = firstValue(item, ['id', 'feed_id', 'feedId', 'noteId', 'note_id'], '');
    const xsecToken = firstValue(item, ['xsecToken', 'xsec_token'], '');
    const publishTime = firstValue(card, ['time', 'createTime', 'create_time', 'publishedAt', 'published_at'], firstValue(item, ['time', 'create_time'], ''));
    const type = firstValue(card, ['type'], firstValue(item, ['type'], ''));
    const hasSummary = Boolean(summary);
    const cardSummary = hasSummary ? summary : publishTime ? `发布时间：${formatDateTime(publishTime)}` : '正在获取发布时间…';
    const cardMeta = `${type === 'video' ? '视频' : '图文'}${publishTime ? ` · ${formatDateTime(publishTime)}` : ''}`;
    return `<article class="xhs-result-row" role="button" tabindex="0" data-feed-id="${escapeHtml(feedId)}" data-xsec-token="${escapeHtml(xsecToken)}"><img src="${escapeHtml(image.startsWith('http') || image.startsWith('/') ? image : '/assets/thumb-camp.svg')}" alt="内容配图" referrerpolicy="no-referrer" /><div class="xhs-result-copy"><strong>${escapeHtml(title)}</strong><p data-result-summary data-has-summary="${hasSummary}">${escapeHtml(cardSummary)}</p><small data-result-meta>${escapeHtml(cardMeta)}</small></div><div class="xhs-result-metrics"><span>♡ ${escapeHtml(likes)}</span><span>☆ ${escapeHtml(collects)}</span><span>◌ ${escapeHtml(comments)}</span></div></article>`;
  }).join('');
  void enrichResultCards([...results.querySelectorAll('.xhs-result-row')]);
}

function renderDetail(note, comments = []) {
  const interact = note?.interactInfo || note?.interact_info || {};
  const user = note?.user || note?.userInfo || note?.user_info || {};
  const images = noteImages(note);
  const cover = images[0] || firstValue(note?.cover || {}, ['urlDefault', 'url_default', 'urlPre', 'url'], '/assets/thumb-camp.svg');
  const type = firstValue(note, ['type'], '') === 'video' || note?.video ? '视频' : '图文';
  const publishedAt = firstValue(note, ['time', 'createTime', 'create_time', 'publishedAt', 'published_at'], '');
  $('#detailCover').src = cover.startsWith('http') || cover.startsWith('/') ? cover : '/assets/thumb-camp.svg';
  $('#detailTitle').textContent = firstValue(note, ['title', 'displayTitle', 'display_title'], '笔记详情');
  $('#detailAuthor').textContent = firstValue(user, ['nickname', 'nickName', 'name'], '未知作者');
  $('#detailType').textContent = type;
  $('#detailPublishedLabel').textContent = type === '视频' ? '视频发布时间' : '发布时间';
  $('#detailPublishedAt').textContent = formatDateTime(publishedAt);
  $('#detailIpLocation').textContent = firstValue(note, ['ipLocation', 'ip_location'], '');
  $('#detailDescription').textContent = firstValue(note, ['desc', 'description', 'content'], '暂无正文描述');
  $('#detailMetrics').innerHTML = [
    ['点赞', firstValue(interact, ['likedCount', 'liked_count', 'likeCount', 'like_count'], '—')],
    ['收藏', firstValue(interact, ['collectedCount', 'collected_count', 'collectCount', 'collect_count'], '—')],
    ['评论', firstValue(interact, ['commentCount', 'comment_count', 'comments'], comments.length)],
    ['分享', firstValue(interact, ['sharedCount', 'shared_count', 'shareCount', 'share_count'], '—')]
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(formatCount(value))}</strong></div>`).join('');
  $('#detailGallery').innerHTML = images.slice(0, 8).map((image, index) => `<img src="${escapeHtml(image)}" alt="笔记图片 ${index + 1}" referrerpolicy="no-referrer" />`).join('');
  $('#detailCommentCount').textContent = `${comments.length} 条${interact.commentCount || interact.comment_count ? ` · 共 ${escapeHtml(formatCount(interact.commentCount || interact.comment_count))} 条` : ''}`;
  if (!comments.length) {
    $('#detailComments').innerHTML = '<div class="xhs-action-empty">暂无评论</div>';
    return;
  }
  $('#detailComments').innerHTML = comments.map(comment => {
    const commentUser = comment?.userInfo || comment?.user_info || comment?.user || {};
    const subCount = firstValue(comment, ['subCommentCount', 'sub_comment_count'], '');
    const location = firstValue(comment, ['ipLocation', 'ip_location'], '');
    return `<article class="xhs-comment-row"><div class="xhs-comment-avatar">${escapeHtml(firstValue(commentUser, ['nickname', 'nickName', 'name'], '匿').slice(0, 1))}</div><div class="xhs-comment-copy"><div class="xhs-comment-meta"><strong>${escapeHtml(firstValue(commentUser, ['nickname', 'nickName', 'name'], '匿名用户'))}</strong><span>${escapeHtml(formatDateTime(firstValue(comment, ['createTime', 'create_time', 'time'], '')))}${location ? ` · ${escapeHtml(location)}` : ''}</span></div><p>${escapeHtml(firstValue(comment, ['content', 'text', 'desc'], ''))}</p><small>♡ ${escapeHtml(firstValue(comment, ['likeCount', 'like_count', 'likedCount'], '0'))}${subCount ? `　${escapeHtml(subCount)} 条回复` : ''}</small></div></article>`;
  }).join('');
}

async function loadDetail(feedId, xsecToken, row = null) {
  if (!feedId) return showToast('这条内容缺少笔记 ID，无法读取详情');
  $('#detailModal').hidden = false;
  $('#detailTitle').textContent = row?.querySelector('.xhs-result-copy strong')?.textContent || '正在读取笔记详情…';
  $('#detailAuthor').textContent = '正在读取作者信息…';
  $('#detailCover').src = row?.querySelector('img')?.src || '/assets/thumb-camp.svg';
  $('#detailType').textContent = row?.querySelector('[data-result-meta]')?.textContent?.split(' · ')[0] || '读取中';
  $('#detailIpLocation').textContent = '';
  $('#detailPublishedLabel').textContent = '发布时间';
  $('#detailPublishedAt').textContent = row?.querySelector('[data-result-meta]')?.textContent?.split(' · ')[1] || '正在读取…';
  $('#detailMetrics').innerHTML = '<div><span>点赞</span><strong>…</strong></div><div><span>收藏</span><strong>…</strong></div><div><span>评论</span><strong>…</strong></div><div><span>分享</span><strong>…</strong></div>';
  $('#detailDescription').textContent = '正在读取正文…';
  $('#detailGallery').innerHTML = '';
  $('#detailComments').innerHTML = '<div class="xhs-action-state loading">正在读取评论…</div>';
  try {
    const payload = await fetchFeedDetail(feedId, xsecToken);
    const { note, comments } = detailNoteOf(payload);
    renderDetail(note, Array.isArray(comments) ? comments : findArray(comments, ['list', 'comments']));
  } catch (error) {
    $('#detailTitle').textContent = '详情读取失败';
    $('#detailDescription').textContent = error.message || '请检查 MCP 服务和登录状态';
    $('#detailComments').innerHTML = '';
  }
}

function closeDetail() { $('#detailModal').hidden = true; }

async function loadQuickAction(action, keyword = '') {
  const stateEl = $('#actionState');
  const results = $('#actionResults');
  stateEl.className = 'xhs-action-state loading';
  stateEl.textContent = '正在从 MCP 读取…';
  results.innerHTML = '';
  try {
    const tool = action === 'feeds' ? 'list_feeds' : action === 'notifications' ? 'get_unread_count' : 'search_feeds';
    const payload = action === 'search' ? { keyword } : {};
    const response = parseToolResult(await callTool(tool, payload));
    stateEl.className = 'xhs-action-state';
    stateEl.textContent = action === 'search' ? `搜索结果 · ${keyword}` : action === 'feeds' ? '首页推荐 · 最近内容' : '通知概览 · 未读数量';
    renderActionResults(action, response);
  } catch (error) {
    stateEl.className = 'xhs-action-state error';
    stateEl.textContent = error.message || '读取失败，请检查 MCP 服务和登录状态';
  }
}

function openActionModal(action) {
  const config = {
    search: ['搜索笔记', '输入关键词后，从小红书 MCP 搜索笔记。'],
    feeds: ['获取推荐', '从首页推荐中读取最近的内容。'],
    notifications: ['查看通知', '查看评论、点赞和关注的未读数量。']
  }[action];
  if (!config) return;
  $('#actionModalTitle').textContent = config[0];
  $('#actionModalHint').textContent = config[1];
  $('#actionModal').hidden = false;
  $('#actionSearchForm').hidden = action !== 'search';
  $('#actionState').className = 'xhs-action-state';
  $('#actionResults').innerHTML = '';
  if (action === 'search') {
    $('#actionState').textContent = '等待输入关键词';
    $('#actionSearchInput').value = '';
    $('#actionSearchInput').focus();
  } else {
    void loadQuickAction(action);
  }
}

function closeActionModal() { $('#actionModal').hidden = true; }

function quickAction(action) { openActionModal(action); }

document.querySelectorAll('.xhs-nav-item').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.xhs-nav-item').forEach(item => item.classList.toggle('active', item === button));
  const section = button.dataset.section;
  if (section === 'compose' || section === 'overview') $('#composeSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (section === 'insights') $('#insightsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (section === 'settings') showToast('连接设置 · 当前使用本机 MCP Bridge');
}));
$('#noteTitle').addEventListener('input', updateTitleCount);
document.querySelectorAll('.xhs-tag').forEach(tag => tag.addEventListener('click', () => tag.classList.toggle('active')));
document.querySelectorAll('.xhs-media-card').forEach(card => card.addEventListener('click', () => {
  document.querySelectorAll('.xhs-media-card').forEach(item => item.classList.remove('selected'));
  card.classList.add('selected');
  state.selectedImage = card.dataset.media;
}));
$('#mediaInput').addEventListener('change', event => { if (event.target.files.length) showToast(`已选择 ${event.target.files.length} 张图片（仅预览）`); });
$('#previewNote').addEventListener('click', openPreview);
$('#closePreview').addEventListener('click', closePreview);
$('#closePreviewAction').addEventListener('click', closePreview);
$('#previewModal').addEventListener('click', event => { if (event.target === $('#previewModal')) closePreview(); });
$('#closeAction').addEventListener('click', closeActionModal);
$('#actionModal').addEventListener('click', event => { if (event.target === $('#actionModal')) closeActionModal(); });
$('#actionSearchForm').addEventListener('submit', event => { event.preventDefault(); const keyword = $('#actionSearchInput').value.trim(); if (!keyword) { $('#actionState').textContent = '请先输入搜索关键词'; return; } void loadQuickAction('search', keyword); });
$('#actionResults').addEventListener('click', event => {
  const row = event.target.closest('.xhs-result-row');
  if (row) void loadDetail(row.dataset.feedId, row.dataset.xsecToken, row);
});
$('#actionResults').addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('.xhs-result-row');
  if (row) { event.preventDefault(); void loadDetail(row.dataset.feedId, row.dataset.xsecToken, row); }
});
$('#closeDetail').addEventListener('click', closeDetail);
$('#detailModal').addEventListener('click', event => { if (event.target === $('#detailModal')) closeDetail(); });
$('#saveDraft').addEventListener('click', () => showToast('草稿已保存到本地预览状态'));
$('#jumpCompose').addEventListener('click', () => $('#composeSection').scrollIntoView({ behavior: 'smooth', block: 'start' }));
$('#viewAll').addEventListener('click', () => showToast('内容列表已是当前预览的全部内容'));
$('#checkConnection').addEventListener('click', () => connectMcp(true));
$('#sidebarConnect').addEventListener('click', () => connectMcp(true));
$('#checkLogin').addEventListener('click', checkLogin);
document.querySelectorAll('.xhs-quick-item').forEach(item => item.addEventListener('click', () => quickAction(item.dataset.action)));
updateTitleCount();
connectMcp(false);
