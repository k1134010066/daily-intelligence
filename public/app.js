const state = { contents: [], platform: '全部', query: '', contentKeyword: '全部', timeRange: 90, agentDigest: null, collectionNotice: '' };
const $ = selector => document.querySelector(selector);
const defaultFallback = '/assets/review-preview.svg';
let automationEditing = false;
let authRequired = false;

function attachImageFallback(image, fallback = defaultFallback) {
  image.dataset.fallback = fallback;
  image.addEventListener('error', () => {
    if (image.src.endsWith(fallback)) return;
    image.src = fallback;
    image.classList.add('image-fallback');
  }, { once: true });
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function showAuthModal(message = '') {
  $('#authModal').hidden = false;
  $('#authError').textContent = message;
  setTimeout(() => $('#authPassword').focus(), 0);
}

function hideAuthModal() {
  $('#authModal').hidden = true;
  $('#authPassword').value = '';
  $('#authError').textContent = '';
}

function handleUnauthorized(response) {
  if (response.status !== 401) return false;
  showAuthModal('登录已过期，请重新登录。');
  return true;
}

async function loadAuthStatus() {
  const response = await fetch('/api/auth/status');
  const data = await response.json();
  authRequired = Boolean(data.required);
  if (authRequired && !data.authenticated) showAuthModal();
  return data;
}

async function login(event) {
  event.preventDefault();
  const button = $('#authForm button[type="submit"]');
  const password = $('#authPassword').value;
  button.disabled = true;
  $('#authError').textContent = '';
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error === 'invalid_password' ? '密码错误，请重试。' : '登录失败，请稍后重试。');
    hideAuthModal();
    await Promise.all([loadDashboard(), loadAutomation(), loadXhsLoginStatus()]);
  } catch (error) {
    $('#authError').textContent = error.message || '登录失败，请稍后重试。';
  } finally {
    button.disabled = false;
  }
}

function renderSummary(data) {
  $('#newTrends').textContent = data.contents?.length ?? state.contents.length;
  $('#pendingReview').textContent = data.summary.pendingReview;
  $('#todayPushed').textContent = data.summary.todayPushed;
  $('#lastUpdated').textContent = data.lastUpdated;
}

function renderReview(review) {
  $('#reviewImage').src = review.image;
  $('#reviewImageLink').href = review.sourceUrl || review.image;
  attachImageFallback($('#reviewImage'), '/assets/review-preview.svg');
  $('#reviewImage').classList.toggle('image-fallback', review.image.startsWith('/api/crawler-media/'));
  $('#reviewTitle').textContent = review.title;
  $('#reviewSubtitle').textContent = review.subtitle;
  $('#reviewTags').innerHTML = review.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
  const approved = review.status === 'approved';
  const waitingForConfig = Object.values(review.dispatch || {}).includes('configuration-required');
  const empty = !review.items?.length;
  $('#reviewStatus').textContent = approved ? (waitingForConfig ? 'PNG 已锁定，等待渠道配置' : 'PNG 已锁定，已进入分发队列') : `一图流 · ${review.items?.length || 0} 条 · ${review.publishedAt}`;
  $('#reviewDot').classList.toggle('approved', approved);
  const button = $('#approveButton');
  button.disabled = approved || empty;
  button.textContent = approved ? '已审核 · 等待分发' : empty ? '暂无内容可审核' : '审核通过并进入分发';
}

function renderDispatch(channels = {}, dispatch = null) {
  const labels = {
    queued: '已入队',
    sent: '已发送',
    'configuration-required': '待配置',
    'subscription-required': '待用户订阅'
  };
  const setStatus = (id, key) => {
    const element = $(id);
    const value = dispatch?.[key] || channels[key] || '待配置';
    element.textContent = labels[value] || value;
    element.classList.toggle('queued', value === 'queued' || value === 'sent');
  };
  setStatus('#wechatDispatch', 'wechat');
  setStatus('#enterpriseWechatDispatch', 'enterpriseWechat');
  setStatus('#feishuDispatch', 'feishu');
}

async function reviewImageToPngDataUrl(source) {
  const response = await fetch(source);
  if (!response.ok) throw new Error('一图流预览加载失败');
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1600;
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function renderContents() {
  const query = state.query.toLowerCase();
  const keyword = state.contentKeyword;
  const cutoff = Date.now() - state.timeRange * 24 * 60 * 60 * 1000;
  const items = state.contents.filter(item => {
    const coreKeyword = item.coreKeyword || item.sourceKeyword || item.tags?.[0] || '';
    const matchesTime = !item.timestamp || item.timestamp >= cutoff;
    const matchesKeyword = keyword === '全部' || coreKeyword === keyword;
    const matchesPlatform = state.platform === '全部' || item.platform === state.platform;
    return matchesTime && matchesKeyword && matchesPlatform && `${item.title} ${item.summary} ${coreKeyword} ${item.platform}`.toLowerCase().includes(query);
  });
  document.querySelectorAll('[data-time-range]').forEach(button => button.classList.toggle('active', Number(button.dataset.timeRange) === state.timeRange));
  renderContentKeywords();
  const list = $('#contentList');
  if (!items.length) {
    const notice = state.collectionNotice || '当前筛选条件下没有匹配的重点内容。';
    list.innerHTML = `<div class="empty-state"><strong>暂无符合条件的高赞内容</strong><span>${escapeHtml(notice)}</span></div>`;
    return;
  }
  list.innerHTML = items.map(item => { const coreKeyword = item.coreKeyword || item.sourceKeyword || item.tags?.[0] || ''; return `<article class="content-row" data-content-id="${escapeHtml(item.id)}" tabindex="0"><img class="content-thumb" src="${escapeHtml(item.image)}" data-fallback="${escapeHtml(item.image.startsWith('/api/crawler-media/') ? item.image : defaultFallback)}" alt="${escapeHtml(item.title)}封面" /><div><h3 class="content-title">${escapeHtml(item.title)}</h3><p class="content-summary">${escapeHtml(item.summary)}</p><div class="content-meta">${escapeHtml(item.platform)} · ${escapeHtml(item.time)} · ${coreKeyword ? `<button class="inline-keyword" type="button" data-content-keyword="${escapeHtml(coreKeyword)}">#${escapeHtml(coreKeyword)}</button>` : ''}</div></div><div class="metrics"><span class="metric">点赞<strong>${escapeHtml(item.likes)}</strong></span><span class="metric">收藏<strong>${escapeHtml(item.collects)}</strong></span><span class="metric">评论<strong>${escapeHtml(item.comments)}</strong></span></div></article>`; }).join('');
  list.querySelectorAll('.content-thumb').forEach(image => {
    attachImageFallback(image, image.dataset.fallback || defaultFallback);
    image.classList.toggle('image-fallback', image.src.includes('/api/crawler-media/'));
  });
  list.querySelectorAll('[data-content-id]').forEach(row => {
    row.addEventListener('click', event => { if (!event.target.closest('.inline-keyword')) openDetail(row.dataset.contentId); });
    row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(row.dataset.contentId); } });
  });
  list.querySelectorAll('.inline-keyword').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); state.contentKeyword = button.dataset.contentKeyword; renderContents(); }));
}

function renderContentKeywords() {
  const keywords = [...new Set(state.contents.map(item => item.coreKeyword || item.sourceKeyword || item.tags?.[0]).filter(Boolean))].slice(0, 24);
  const container = $('#contentKeywords');
  if (!container) return;
  container.innerHTML = ['全部', ...keywords].map(keyword => `<button class="content-keyword ${state.contentKeyword === keyword ? 'active' : ''}" type="button" data-content-keyword="${escapeHtml(keyword)}">${escapeHtml(keyword)}</button>`).join('');
  container.querySelectorAll('button').forEach(button => button.addEventListener('click', () => { state.contentKeyword = button.dataset.contentKeyword; renderContents(); }));
}

async function loadDashboard() {
  try {
    const response = await fetch('/api/dashboard');
    if (handleUnauthorized(response)) return;
    if (!response.ok) throw new Error('dashboard unavailable');
    const data = await response.json();
    state.contents = data.contents;
    state.agentDigest = data.agentDigest;
    state.collectionNotice = data.collectionNotice || '';
    renderSummary(data);
    renderReview(data.review);
    renderDispatch(data.channels, data.review.dispatch);
    renderContents();
  } catch {
    showToast('无法连接到服务，请确认已运行 npm start');
  }
}

async function syncCrawler() {
  const button = $('#crawlerSync');
  button.disabled = true;
  button.textContent = '同步中…';
  try {
    const response = await fetch('/api/collector/sync', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '采集同步失败');
    await loadDashboard();
    showToast(result.imported ? `已同步 ${result.imported} 条采集结果` : '暂未发现新的采集结果');
  } catch (error) { showToast(error.message || '采集结果同步失败'); }
  button.disabled = false;
  button.textContent = '同步采集结果';
}

function renderAutomation(data) {
  if (!automationEditing) renderKeywordCatalog(data);
  document.querySelectorAll('[data-schedule]').forEach(input => { input.checked = data.scheduleTimes.includes(input.value); });
  document.querySelectorAll('[data-platform]').forEach(input => { input.checked = data.enabledPlatforms.includes(input.value); });
  const stateLabel = $('#schedulerState');
  stateLabel.textContent = data.running ? `运行中 · ${data.currentPlatform || ''}` : data.lastNotice ? '已完成 · 有筛选提示' : '调度器已启用';
  stateLabel.style.color = data.lastError || data.lastNotice ? '#ff9a48' : '#77d69e';
  $('#schedulerLog').textContent = data.log?.length ? data.log.join('\n') : '尚未运行采集任务';
}

function renderKeywordCatalog(data) {
  const selectedTracks = new Set(data.config.selectedTracks || []);
  const updateSelectionSummary = () => {
    const selectedIds = new Set([...document.querySelectorAll('[data-track]:checked')].map(input => input.dataset.track));
    const expandedCount = data.keywordCatalog.filter(topic => selectedIds.has(topic.id)).reduce((total, topic) => total + topic.keywords.length, 0);
    $('#keywordSelectionSummary').textContent = selectedIds.size ? `已选 ${selectedIds.size} 个主题 · 将使用 ${expandedCount} 个相关搜索词` : '请至少选择一个关注主题';
  };
  $('#keywordCatalog').innerHTML = data.keywordCatalog.map(topic => `<label class="keyword-topic ${selectedTracks.has(topic.id) ? 'selected' : ''}" title="${escapeHtml(`${topic.description}；扩展搜索：${topic.keywords.join('、')}`)}"><input type="checkbox" data-track="${escapeHtml(topic.id)}" ${selectedTracks.has(topic.id) ? 'checked' : ''} /><span class="keyword-topic-check">✓</span><strong>${escapeHtml(topic.label)}</strong></label>`).join('');
  document.querySelectorAll('[data-track]').forEach(input => input.addEventListener('change', () => {
    input.closest('.keyword-topic').classList.toggle('selected', input.checked);
    automationEditing = true;
    updateSelectionSummary();
  }));
  updateSelectionSummary();
}

async function loadAutomation() {
  try {
    const response = await fetch('/api/automation');
    if (handleUnauthorized(response)) return;
    if (!response.ok) throw new Error('automation unavailable');
    renderAutomation(await response.json());
  } catch { $('#schedulerState').textContent = '调度器状态不可用'; }
}

function currentAutomationPayload() {
  return {
    selectedTracks: [...document.querySelectorAll('[data-track]:checked')].map(input => input.dataset.track),
    scheduleTimes: [...document.querySelectorAll('[data-schedule]:checked')].map(input => input.value),
    enabledPlatforms: [...document.querySelectorAll('[data-platform]:checked')].map(input => input.value)
  };
}

async function persistCurrentAutomation(showMessage = false) {
  const response = await fetch('/api/automation/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentAutomationPayload()) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '设置保存失败');
  automationEditing = false;
  renderAutomation(data);
  if (showMessage) showToast('采集设置已保存');
  return data;
}

async function saveAutomation(event) {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try { await persistCurrentAutomation(true); } catch (error) { showToast(error.message || '设置保存失败'); }
  button.disabled = false;
}

async function addAdminTopic() {
  const button = $('#addTopicButton');
  const label = $('#adminTopicLabel').value.trim();
  const keywords = $('#adminTopicKeywords').value.split(/[，,、\n]/).map(item => item.trim()).filter(Boolean);
  if (!label) { showToast('请先填写主题名称'); return; }
  button.disabled = true;
  try {
    const response = await fetch('/api/automation/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, keywords }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    automationEditing = false;
    renderAutomation(data);
    $('#adminTopicLabel').value = '';
    $('#adminTopicKeywords').value = '';
    showToast(`已新增并选中“${label}”`);
  } catch (error) { showToast(error.message || '新增主题失败'); }
  button.disabled = false;
}

async function loadXhsLoginStatus(silent = true) {
  const status = $('#xhsLoginStatus');
  try {
    const response = await fetch('/api/xhs/login-status');
    if (handleUnauthorized(response)) return false;
    const data = await response.json();
    status.textContent = data.loggedIn ? '已登录，可以采集' : '未登录，采集会返回 0 条';
    status.className = `xhs-login-status ${data.loggedIn ? 'logged-in' : 'logged-out'}`;
    $('#xhsLoginButton').textContent = data.loggedIn ? '重新登录' : '获取登录二维码';
    if (data.loggedIn) {
      $('#xhsLoginModal').hidden = true;
      clearInterval(loadXhsLoginStatus.poller);
    } else if (!silent) showToast('请先扫码登录小红书');
    return data.loggedIn;
  } catch {
    status.textContent = '登录状态检查失败';
    status.className = 'xhs-login-status logged-out';
    return false;
  }
}

async function showXhsLoginQr() {
  const button = $('#xhsLoginButton');
  button.disabled = true;
  button.textContent = '正在生成…';
  try {
    const response = await fetch('/api/xhs/login-qrcode', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    $('#xhsQrImage').src = data.image;
    $('#xhsQrMessage').textContent = data.message;
    $('#xhsLoginModal').hidden = false;
    $('#xhsLoginStatus').textContent = '等待扫码登录…';
    $('#xhsLoginStatus').className = 'xhs-login-status checking';
    clearInterval(loadXhsLoginStatus.poller);
    loadXhsLoginStatus.poller = setInterval(() => loadXhsLoginStatus(true), 3000);
  } catch (error) { showToast(error.message || '二维码生成失败'); }
  button.disabled = false;
  button.textContent = '重新生成二维码';
}

function closeXhsLoginModal() {
  $('#xhsLoginModal').hidden = true;
  clearInterval(loadXhsLoginStatus.poller);
}

async function runNow() {
  const button = $('#runNowButton');
  button.disabled = true;
  button.textContent = '已加入运行队列';
  try {
    await persistCurrentAutomation(false);
    const xhsEnabled = document.querySelector('[data-platform][value="xhs"]')?.checked;
    if (xhsEnabled && !(await loadXhsLoginStatus(true))) {
      await showXhsLoginQr();
      button.disabled = false;
      button.textContent = '立即运行一次';
      return;
    }
    const response = await fetch('/api/automation/run', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    showToast('已按当前选择启动采集，完成后会自动同步');
    const poll = setInterval(async () => {
      const status = await fetch('/api/automation').then(result => result.json());
      renderAutomation(status);
      if (!status.running) { clearInterval(poll); button.disabled = false; button.textContent = '立即运行一次'; await loadDashboard(); showToast(status.lastError ? '采集失败，请查看运行日志' : status.lastNotice || '采集完成，页面已同步'); }
    }, 3000);
  } catch (error) { button.disabled = false; button.textContent = '立即运行一次'; showToast(error.message || '启动采集失败'); }
}

function selectPlatform(platform) {
  state.platform = platform;
  document.querySelectorAll('.platform-tab').forEach(button => button.classList.toggle('active', button.dataset.platform === platform));
  renderContents();
}

async function approveReview() {
  const button = $('#approveButton');
  button.disabled = true;
  button.textContent = '正在生成并锁定 PNG…';
  try {
    const imageDataUrl = await reviewImageToPngDataUrl($('#reviewImage').src);
    const response = await fetch('/api/review/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageDataUrl }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    renderSummary({ summary: data.summary, lastUpdated: '刚刚' });
    renderReview(data.review);
    renderDispatch({}, data.dispatch);
    showToast(Object.values(data.dispatch).includes('configuration-required') ? '一图流已锁定；请配置分发渠道' : '一图流已进入分发队列');
  } catch (error) { button.disabled = false; button.textContent = '审核通过并进入分发'; showToast(error.message || '审核操作失败，请稍后重试'); }
}

function openDetail(id) {
  const item = state.contents.find(content => content.id === id);
  if (!item) return;
  $('#modalImage').src = item.image;
  attachImageFallback($('#modalImage'), '/assets/review-preview.svg');
  $('#modalImage').alt = `${item.title}封面`;
  $('#modalMeta').textContent = `${item.platform} · ${item.time}`;
  $('#modalTitle').textContent = item.title;
  $('#modalSummary').textContent = item.summary;
  $('#modalTags').innerHTML = item.tags.map(tag => `<span class="tag">#${escapeHtml(tag)}</span>`).join('');
  $('#modalMetrics').innerHTML = `<span>点赞 ${escapeHtml(item.likes)}</span><span>收藏 ${escapeHtml(item.collects)}</span><span>评论 ${escapeHtml(item.comments)}</span>`;
  $('#modalLink').href = item.url;
  $('#detailModal').hidden = false;
  $('#modalClose').focus();
}

function closeDetail() { $('#detailModal').hidden = true; }

function wireInteractions() {
  $('#authForm').addEventListener('submit', login);
  document.querySelectorAll('.platform-tab').forEach(button => button.addEventListener('click', () => selectPlatform(button.dataset.platform)));
  $('#approveButton').addEventListener('click', approveReview);
  $('#refreshButton').addEventListener('click', () => { loadDashboard(); showToast('已刷新最新情报'); });
  $('#crawlerSync').addEventListener('click', syncCrawler);
  $('#automationForm').addEventListener('submit', saveAutomation);
  $('#runNowButton').addEventListener('click', runNow);
  $('#addTopicButton').addEventListener('click', addAdminTopic);
  $('#xhsLoginButton').addEventListener('click', showXhsLoginQr);
  $('#xhsLoginModalClose').addEventListener('click', closeXhsLoginModal);
  $('#xhsLoginModal').addEventListener('click', event => { if (event.target.id === 'xhsLoginModal') closeXhsLoginModal(); });
  $('#searchInput').addEventListener('input', event => { state.query = event.target.value.trim(); renderContents(); });
  document.querySelectorAll('[data-time-range]').forEach(button => button.addEventListener('click', () => { state.timeRange = Number(button.dataset.timeRange); renderContents(); }));
  $('#modalClose').addEventListener('click', closeDetail);
  $('#detailModal').addEventListener('click', event => { if (event.target.id === 'detailModal') closeDetail(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeDetail(); closeXhsLoginModal(); } });
  document.querySelectorAll('[data-focus]').forEach(card => card.addEventListener('click', () => document.getElementById(card.dataset.focus).scrollIntoView({ behavior: 'smooth', block: 'center' })));
  document.querySelectorAll('[data-nav]').forEach(item => item.addEventListener('click', () => {
    document.querySelectorAll('[data-nav]').forEach(nav => nav.classList.toggle('active', nav === item));
    const target = item.dataset.nav === 'review' ? 'reviewCard' : item.dataset.nav === 'settings' ? 'settingsCard' : 'contentCard';
    if (item.dataset.nav === 'settings') showToast('后端采集与 Agent 配置已加载');
    document.getElementById(target).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

async function bootstrap() {
  try {
    wireInteractions();
    const auth = await loadAuthStatus();
    if (auth.required && !auth.authenticated) return;
    await Promise.all([loadDashboard(), loadAutomation(), loadXhsLoginStatus()]);
    setInterval(loadAutomation, 10000);
  } catch {
    showToast('无法连接到服务，请确认后端已经启动');
  }
}

bootstrap();
