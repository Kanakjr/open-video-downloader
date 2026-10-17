import { cleanTitle, estimateHlsSize } from '../lib/hls-parser.js';

let activeStreams = [];
let currentFilter = 'all';
let searchQuery = '';
let currentTabId = null;
let currentTabUrl = '';

// Navigation Elements
const tabBtnStreams = document.getElementById('tabBtnStreams');
const tabBtnDownloads = document.getElementById('tabBtnDownloads');
const viewStreams = document.getElementById('viewStreams');
const viewDownloads = document.getElementById('viewDownloads');
const navCountStreams = document.getElementById('navCountStreams');
const navCountDownloads = document.getElementById('navCountDownloads');

// Streams View DOM Elements
const streamListEl = document.getElementById('streamList');
const emptyStateEl = document.getElementById('emptyState');
const searchInput = document.getElementById('searchInput');
const filterBtns = document.querySelectorAll('.filter-btn');
const btnRescan = document.getElementById('btnRescan');
const btnClear = document.getElementById('btnClear');

// Count Elements
const countAllEl = document.getElementById('countAll');
const countHlsEl = document.getElementById('countHls');
const countVideoEl = document.getElementById('countVideo');
const countAudioEl = document.getElementById('countAudio');

// Streams Quick Banner Elements
const activeDownloadCard = document.getElementById('activeDownloadSection');
const downloadTitleEl = document.getElementById('downloadTitle');
const downloadStatusEl = document.getElementById('downloadStatus');
const downloadProgressBar = document.getElementById('downloadProgressBar');
const downloadMetaText = document.getElementById('downloadMetaText');
const btnCancelDownload = document.getElementById('btnCancelDownload');

// Downloads View Elements
const runningDownloadsList = document.getElementById('runningDownloadsList');
const noActiveDownloadsMsg = document.getElementById('noActiveDownloadsMsg');
const historyList = document.getElementById('historyList');
const emptyHistoryState = document.getElementById('emptyHistoryState');
const btnClearHistory = document.getElementById('btnClearHistory');

// Modal Elements
const commandModal = document.getElementById('commandModal');
const btnCloseModal = document.getElementById('btnCloseModal');
const cmdFfmpegEl = document.getElementById('cmdFfmpeg');
const cmdYtdlpEl = document.getElementById('cmdYtdlp');
const cmdUrlEl = document.getElementById('cmdUrl');

let pollingInterval = null;

/**
 * Initializes the popup and loads streams for the active tab.
 */
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  currentTabId = tab.id;
  currentTabUrl = tab.url || '';

  await loadStreams();
  await syncBackgroundDownloads();
  await loadDownloadHistory();
  setupEventListeners();

  // Periodic poll to keep running downloads synced with background service worker
  pollingInterval = setInterval(syncBackgroundDownloads, 1000);
  window.addEventListener('unload', () => {
    if (pollingInterval) clearInterval(pollingInterval);
  });
}

/**
 * Fetches streams from background service worker.
 */
async function loadStreams() {
  if (!currentTabId) return;

  try {
    const res = await chrome.runtime.sendMessage({
      action: 'GET_TAB_STREAMS',
      tabId: currentTabId
    });

    if (res && res.success && Array.isArray(res.streams)) {
      activeStreams = res.streams;
      renderStreams();
      checkAndFetchThumbnails();
    }
  } catch (err) {
    console.error('Failed to load streams:', err);
  }
}

/**
 * Ensures streams display a real video preview using 3-tier fallback.
 */
async function checkAndFetchThumbnails() {
  const missing = activeStreams.filter(s => !s.thumbnail);
  if (missing.length === 0) return;

  // 1. Proactively query page content script for DOM poster/og:image/canvas
  try {
    const pageMeta = await chrome.tabs.sendMessage(currentTabId, { action: 'REQUEST_PAGE_THUMBNAIL' }).catch(() => null);
    if (pageMeta && pageMeta.thumbnail) {
      applyThumbnailToMissing(pageMeta.thumbnail);
      return;
    }
  } catch {
    // Page script not accessible
  }

  // 2. In-page video frame capture from visible screen (bypasses CORS/taint completely)
  try {
    const screenThumb = await tryCaptureScreenThumbnail();
    if (screenThumb) {
      applyThumbnailToMissing(screenThumb);
      return;
    }
  } catch {
    // Screen capture skipped
  }

  // 3. For HLS streams, generate from stream segment 0 via offscreen engine
  for (const s of missing) {
    if (s.type === 'hls') {
      try {
        const offRes = await chrome.runtime.sendMessage({
          target: 'OFFSCREEN',
          action: 'GENERATE_STREAM_THUMBNAIL',
          streamUrl: s.url
        }).catch(() => null);

        if (offRes && offRes.thumbnail) {
          s.thumbnail = offRes.thumbnail;
          await chrome.runtime.sendMessage({
            action: 'UPDATE_STREAM_THUMBNAIL',
            tabId: currentTabId,
            streamUrl: s.url,
            thumbnail: offRes.thumbnail
          }).catch(() => {});
          renderStreams();
        }
      } catch {
        // Offscreen thumbnail skipped
      }
    }
  }
}

function applyThumbnailToMissing(thumbnail) {
  let updated = false;
  for (const s of activeStreams) {
    if (!s.thumbnail) {
      s.thumbnail = thumbnail;
      updated = true;
    }
  }

  if (updated) {
    chrome.runtime.sendMessage({
      action: 'UPDATE_STREAM_THUMBNAIL',
      tabId: currentTabId,
      thumbnail
    }).catch(() => {});
    renderStreams();
  }
}

/**
 * Captures visible tab and crops precisely to active video element.
 */
async function tryCaptureScreenThumbnail() {
  if (!currentTabId) return null;
  try {
    const rectRes = await chrome.tabs.sendMessage(currentTabId, { action: 'GET_ACTIVE_VIDEO_RECT' }).catch(() => null);
    if (!rectRes || !rectRes.success || !rectRes.rect) return null;

    const screenshotUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 65 }).catch(() => null);
    if (!screenshotUrl) return null;

    const { x, y, width, height, dpr } = rectRes.rect;
    return await cropImageToThumbnail(screenshotUrl, x * dpr, y * dpr, width * dpr, height * dpr, 160, 90);
  } catch (err) {
    console.debug('Screen capture thumbnail error:', err);
    return null;
  }
}

function cropImageToThumbnail(src, sx, sy, sw, sh, targetW, targetH) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        const safeSx = Math.max(0, Math.min(sx, img.width - 10));
        const safeSy = Math.max(0, Math.min(sy, img.height - 10));
        const safeSw = Math.min(sw, img.width - safeSx);
        const safeSh = Math.min(sh, img.height - safeSy);
        ctx.drawImage(img, safeSx, safeSy, safeSw, safeSh, 0, 0, targetW, targetH);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Deduplicates HLS variants and matching streams for clean presentation.
 */
function deduplicateStreams(streams) {
  const seenGroups = new Map();
  const result = [];

  for (const s of streams) {
    let groupKey = s.groupKey;
    if (!groupKey) {
      try {
        const u = new URL(s.url);
        let p = u.pathname;
        if (p.endsWith('.m3u8')) {
          const parts = p.split('/').filter(Boolean);
          if (parts.length > 1) {
            parts.pop();
            p = '/' + parts.join('/');
          }
        }
        groupKey = `${u.origin}${p}`.toLowerCase();
      } catch {
        groupKey = s.url.split('?')[0].toLowerCase();
      }
    }

    if (!seenGroups.has(groupKey)) {
      seenGroups.set(groupKey, s);
      result.push(s);
    } else {
      const existing = seenGroups.get(groupKey);
      const isIncomingMaster = s.url.toLowerCase().includes('master');
      const isExistingMaster = existing.url.toLowerCase().includes('master');

      if (isIncomingMaster && !isExistingMaster) {
        const idx = result.indexOf(existing);
        if (idx !== -1) result[idx] = s;
        seenGroups.set(groupKey, s);
      } else {
        if (!existing.thumbnail && s.thumbnail) existing.thumbnail = s.thumbnail;
        if (!existing.duration && s.duration) existing.duration = s.duration;
      }
    }
  }

  return result;
}

/**
 * Creates a thumbnail element with safe error handling (no broken image icons).
 */
function createThumbnailElement(thumbnailUrl) {
  const box = document.createElement('div');
  box.className = 'stream-thumbnail-box';

  const renderFallback = () => {
    box.innerHTML = `
      <div class="stream-thumbnail-fallback">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </div>
    `;
  };

  if (thumbnailUrl) {
    const img = document.createElement('img');
    img.className = 'stream-thumbnail-img';
    img.alt = 'Preview';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', renderFallback);
    img.src = thumbnailUrl;
    box.appendChild(img);
  } else {
    renderFallback();
  }

  return box;
}

/**
 * Renders the stream list according to active filter and search query.
 */
function renderStreams() {
  const dedupedStreams = deduplicateStreams(activeStreams);

  // Update counts
  const countHls = dedupedStreams.filter(s => s.type === 'hls').length;
  const countVideo = dedupedStreams.filter(s => s.type === 'direct_video').length;
  const countAudio = dedupedStreams.filter(s => s.type === 'direct_audio').length;

  countAllEl.textContent = dedupedStreams.length;
  countHlsEl.textContent = countHls;
  countVideoEl.textContent = countVideo;
  countAudioEl.textContent = countAudio;
  navCountStreams.textContent = dedupedStreams.length;

  // Filter streams
  const filtered = dedupedStreams.filter(s => {
    if (currentFilter === 'hls' && s.type !== 'hls') return false;
    if (currentFilter === 'video' && s.type !== 'direct_video') return false;
    if (currentFilter === 'audio' && s.type !== 'direct_audio') return false;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchTitle = (s.title || '').toLowerCase().includes(q);
      const matchUrl = (s.url || '').toLowerCase().includes(q);
      const matchFormat = (s.format || '').toLowerCase().includes(q);
      return matchTitle || matchUrl || matchFormat;
    }

    return true;
  });

  if (filtered.length === 0) {
    streamListEl.innerHTML = '';
    emptyStateEl.classList.remove('hidden');
    return;
  }

  emptyStateEl.classList.add('hidden');
  streamListEl.innerHTML = '';

  // Render cards
  filtered.forEach(stream => {
    const card = document.createElement('div');
    card.className = 'stream-card';

    let badgeClass = 'badge-video';
    if (stream.type === 'hls') badgeClass = 'badge-hls';
    else if (stream.type === 'direct_audio') badgeClass = 'badge-audio';

    let domain = '';
    try {
      domain = new URL(stream.url).hostname;
    } catch {
      domain = 'Direct Stream';
    }

    let sizeLabel = null;
    if (stream.size && !stream.isAdaptive) {
      sizeLabel = formatBytes(stream.size);
    } else if (stream.type === 'hls') {
      if (stream.estimatedSize) {
        sizeLabel = `~${formatBytes(stream.estimatedSize)}`;
      } else if (stream.duration) {
        const est = estimateHlsSize(3000000, stream.duration);
        sizeLabel = est ? `~${formatBytes(est)} (Est.)` : 'Adaptive Stream';
      } else {
        sizeLabel = 'Adaptive Stream';
      }
    }

    const durationStr = stream.duration ? formatDuration(stream.duration) : null;
    const resolutionStr = stream.width && stream.height ? `${stream.height}p` : null;
    const displayTitle = cleanTitle(stream.title || stream.filename || 'Video');

    // Create Card Body
    const cardBody = document.createElement('div');
    cardBody.className = 'stream-card-body';

    // Add safe thumbnail
    const thumbEl = createThumbnailElement(stream.thumbnail);
    cardBody.appendChild(thumbEl);

    // Add content container
    const content = document.createElement('div');
    content.className = 'stream-content';
    content.innerHTML = `
      <div class="stream-header">
        <div class="stream-title-group">
          <div class="stream-title" title="Click to rename" data-url="${escapeHtml(stream.url)}">
            <span class="title-text">${escapeHtml(displayTitle)}</span>
            <span class="edit-icon" title="Edit filename" style="cursor: pointer; opacity: 0.6; margin-left: 6px; font-size: 11px;">✏️</span>
          </div>
          <div class="stream-subtitle" title="${escapeHtml(domain)}">
            ${escapeHtml(domain)}
          </div>
        </div>
        <div class="badges-group">
          ${resolutionStr ? `<span class="badge badge-quality">${resolutionStr}</span>` : ''}
          <span class="badge ${badgeClass}">${escapeHtml(stream.format || 'STREAM')}</span>
        </div>
      </div>

      <div class="stream-meta-row">
        ${sizeLabel ? `<span><strong>Size:</strong> ${escapeHtml(sizeLabel)}</span>` : ''}
        ${durationStr ? `<span><strong>Duration:</strong> ${durationStr}</span>` : ''}
        <span><strong>Type:</strong> ${stream.type === 'hls' ? 'HLS (Auto-Remuxed to MP4)' : 'Progressive'}</span>
      </div>
    `;

    cardBody.appendChild(content);
    card.appendChild(cardBody);

    // Action buttons container
    const actions = document.createElement('div');
    actions.className = 'stream-actions';

    const hasVariants = stream.variants && stream.variants.length > 1;
    const hasSubs = stream.subtitles && stream.subtitles.length > 0;

    const variantSelectHtml = hasVariants ? `
      <select class="quality-select" title="Choose Video Quality">
        ${stream.variants.map((v, i) => `
          <option value="${escapeHtml(v.url)}" ${i === 0 ? 'selected' : ''}>
            ${escapeHtml(v.qualityLabel || 'Stream')} (${v.bandwidth ? Math.round(v.bandwidth / 1000) + ' kbps' : 'Best'})
          </option>
        `).join('')}
      </select>
    ` : '';

    const subsBtnHtml = hasSubs ? `
      <button class="btn-secondary btn-subs" title="Download Subtitles (.vtt)">
        💬 Subs
      </button>
    ` : '';

    actions.innerHTML = `
      ${variantSelectHtml}
      <button class="btn-primary btn-download" data-url="${escapeHtml(stream.url)}">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
        Download
      </button>
      <button class="btn-secondary btn-audio" data-url="${escapeHtml(stream.url)}" title="Extract Audio Only (M4A/MP3)">
        🎵 Audio
      </button>
      ${subsBtnHtml}
      <button class="btn-secondary btn-copy" data-url="${escapeHtml(stream.url)}" title="Copy stream URL">
        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy
      </button>
      <button class="btn-secondary btn-commands" data-url="${escapeHtml(stream.url)}" title="CLI commands (FFmpeg/yt-dlp)">
        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        CLI
      </button>
    `;

    card.appendChild(actions);

    // Title rename click listener
    const titleEl = card.querySelector('.stream-title');
    titleEl.addEventListener('click', () => {
      const current = stream.title || displayTitle;
      const newTitle = prompt('Enter a new filename for this video:', current);
      if (newTitle && newTitle.trim()) {
        stream.title = cleanTitle(newTitle.trim());
        const textSpan = titleEl.querySelector('.title-text');
        if (textSpan) textSpan.textContent = stream.title;
      }
    });

    // Action listeners
    const qualitySelect = card.querySelector('.quality-select');
    card.querySelector('.btn-download').addEventListener('click', () => {
      const selectedVariantUrl = qualitySelect ? qualitySelect.value : null;
      handleDownload(stream, { selectedVariantUrl });
    });

    const btnAudio = card.querySelector('.btn-audio');
    if (btnAudio) {
      btnAudio.addEventListener('click', () => {
        handleDownload(stream, { audioOnly: true });
      });
    }

    const btnSubs = card.querySelector('.btn-subs');
    if (btnSubs && stream.subtitles && stream.subtitles.length > 0) {
      btnSubs.addEventListener('click', async () => {
        const sub = stream.subtitles[0];
        const subFilename = `${cleanTitle(stream.title || 'video')}_${sub.language || 'subs'}.vtt`;
        await chrome.runtime.sendMessage({
          action: 'DOWNLOAD_DIRECT',
          url: sub.uri,
          filename: subFilename,
          title: subFilename,
          thumbnail: stream.thumbnail || null
        });
        await loadDownloadHistory();
        switchToTab('downloads');
      });
    }

    card.querySelector('.btn-copy').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      await navigator.clipboard.writeText(stream.url);
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
      }, 1500);
    });
    card.querySelector('.btn-commands').addEventListener('click', () => openCommandsModal(stream));

    streamListEl.appendChild(card);
  });
}

/**
 * Handles download triggering. Dispatches to background service worker so
 * downloads run independently of popup/tab lifecycle.
 */
async function handleDownload(stream, options = {}) {
  let filename = cleanTitle(stream.title || stream.filename || 'video');
  if (options.audioOnly) {
    filename = `${filename}_audio`;
  }

  // Direct progressive download
  if (stream.type === 'direct_video' || stream.type === 'direct_audio') {
    let ext = stream.format.toLowerCase();
    if (!ext || ext.length > 4) ext = stream.type === 'direct_audio' ? 'mp3' : 'mp4';
    if (options.audioOnly) ext = 'mp3';
    const targetFilename = filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;

    await chrome.runtime.sendMessage({
      action: 'DOWNLOAD_DIRECT',
      url: stream.url,
      filename: targetFilename,
      title: stream.title || filename,
      thumbnail: stream.thumbnail || null
    });

    await loadDownloadHistory();
    switchToTab('downloads');
    return;
  }

  // HLS stream: dispatch to background offscreen downloader
  if (stream.type === 'hls') {
    await chrome.runtime.sendMessage({
      action: 'START_HLS_DOWNLOAD',
      stream,
      title: filename,
      filename,
      options
    });

    await syncBackgroundDownloads();
    switchToTab('downloads');
  }
}

/**
 * Synchronizes running background downloads with the UI.
 */
async function syncBackgroundDownloads() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_ACTIVE_DOWNLOADS' });
    if (res && res.success && Array.isArray(res.downloads)) {
      renderActiveDownloads(res.downloads);
    }
  } catch {
    // Service worker may be waking up
  }
}

/**
 * Renders active downloads in both the Streams quick banner and the Downloads view.
 */
function renderActiveDownloads(downloads) {
  const count = downloads.length;

  if (count > 0) {
    navCountDownloads.classList.remove('hidden');
    navCountDownloads.textContent = count.toString();
    noActiveDownloadsMsg.classList.add('hidden');

    // Quick banner in Streams view
    const current = downloads[0];
    activeDownloadCard.classList.remove('hidden');
    downloadTitleEl.textContent = `Downloading: ${current.title}`;
    const pct = current.progress?.percent || 0;
    downloadStatusEl.textContent = `${pct}%`;
    downloadProgressBar.style.width = `${pct}%`;
    downloadMetaText.textContent = current.progress?.statusText || 'Downloading...';
    btnCancelDownload.dataset.streamUrl = current.streamUrl;
  } else {
    navCountDownloads.classList.add('hidden');
    noActiveDownloadsMsg.classList.remove('hidden');
    activeDownloadCard.classList.add('hidden');
  }

  // Render cards in the Downloads View
  const existingCards = runningDownloadsList.querySelectorAll('.download-history-card');
  existingCards.forEach(c => c.remove());

  downloads.forEach(state => {
    const card = document.createElement('div');
    card.className = 'download-history-card';

    const thumbEl = createThumbnailElement(state.thumbnail);
    thumbEl.style.width = '60px';
    thumbEl.style.height = '38px';

    const pct = state.progress?.percent || 0;
    const statusText = state.progress?.statusText || 'Downloading in background...';

    card.appendChild(thumbEl);

    const content = document.createElement('div');
    content.className = 'history-content';
    content.innerHTML = `
      <div class="history-title">${escapeHtml(state.title)}</div>
      <div class="progress-bar-container" style="margin: 4px 0;">
        <div class="progress-bar-fill" style="width: ${pct}%;"></div>
      </div>
      <div class="history-meta" style="font-size: 10px;">
        <span>${pct}% • ${escapeHtml(statusText)}</span>
      </div>
    `;
    card.appendChild(content);

    const actions = document.createElement('div');
    actions.className = 'history-actions';
    actions.innerHTML = `
      <button class="btn-cancel btn-cancel-single" title="Cancel Download">Cancel</button>
    `;
    actions.querySelector('.btn-cancel-single').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        action: 'CANCEL_HLS_DOWNLOAD',
        streamUrl: state.streamUrl
      });
      await syncBackgroundDownloads();
    });

    card.appendChild(actions);
    runningDownloadsList.appendChild(card);
  });
}

/**
 * Fetches and renders completed download history.
 */
async function loadDownloadHistory() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_DOWNLOAD_HISTORY' });
    if (res && res.success && Array.isArray(res.history)) {
      renderDownloadHistory(res.history);
    }
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

/**
 * Renders completed download history items.
 */
function renderDownloadHistory(historyItems) {
  if (historyItems.length === 0) {
    historyList.innerHTML = '';
    emptyHistoryState.classList.remove('hidden');
    return;
  }

  emptyHistoryState.classList.add('hidden');
  historyList.innerHTML = '';

  historyItems.forEach(item => {
    const card = document.createElement('div');
    card.className = 'download-history-card';

    const thumbEl = createThumbnailElement(item.thumbnail);
    thumbEl.style.width = '60px';
    thumbEl.style.height = '38px';

    const sizeStr = item.size ? formatBytes(item.size) : '';
    const dateStr = formatDate(item.timestamp);

    card.appendChild(thumbEl);

    const content = document.createElement('div');
    content.className = 'history-content';
    content.innerHTML = `
      <div class="history-title" title="${escapeHtml(item.filename || item.title)}">
        ${escapeHtml(item.title || item.filename)}
      </div>
      <div class="history-meta">
        ${sizeStr ? `<span>${sizeStr}</span>` : ''}
        <span class="badge badge-quality" style="padding: 1px 4px;">${escapeHtml(item.type || 'MP4')}</span>
        <span>${dateStr}</span>
      </div>
    `;
    card.appendChild(content);

    const actions = document.createElement('div');
    actions.className = 'history-actions';
    actions.innerHTML = `
      <button class="btn-show-folder" title="Show in Finder / Explorer">
        <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        Folder
      </button>
      <button class="btn-delete-history" title="Remove from list">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    `;

    actions.querySelector('.btn-show-folder').addEventListener('click', async () => {
      if (item.downloadId) {
        await chrome.runtime.sendMessage({
          action: 'OPEN_DOWNLOAD_FOLDER',
          downloadId: item.downloadId
        });
      }
    });

    actions.querySelector('.btn-delete-history').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        action: 'REMOVE_DOWNLOAD_HISTORY_ITEM',
        id: item.id
      });
      await loadDownloadHistory();
    });

    card.appendChild(actions);
    historyList.appendChild(card);
  });
}

/**
 * Switches between "Detected Media" and "Downloads" views.
 */
function switchToTab(tabName) {
  if (tabName === 'streams') {
    tabBtnStreams.classList.add('active');
    tabBtnDownloads.classList.remove('active');
    viewStreams.classList.remove('hidden');
    viewStreams.classList.add('active');
    viewDownloads.classList.add('hidden');
    viewDownloads.classList.remove('active');
  } else if (tabName === 'downloads') {
    tabBtnDownloads.classList.add('active');
    tabBtnStreams.classList.remove('active');
    viewDownloads.classList.remove('hidden');
    viewDownloads.classList.add('active');
    viewStreams.classList.add('hidden');
    viewStreams.classList.remove('active');
    loadDownloadHistory();
    syncBackgroundDownloads();
  }
}

/**
 * Opens modal with ready-to-run FFmpeg and yt-dlp commands.
 */
function openCommandsModal(stream) {
  const filename = cleanTitle(stream.title || stream.filename || 'video');
  const initiator = stream.initiator || currentTabUrl || '';

  let ffmpegCmd = `ffmpeg -headers "Referer: ${initiator}\\r\\n" -i "${stream.url}" -c copy "${filename}.mp4"`;
  let ytdlpCmd = `yt-dlp --referer "${initiator}" "${stream.url}"`;

  cmdFfmpegEl.textContent = ffmpegCmd;
  cmdYtdlpEl.textContent = ytdlpCmd;
  cmdUrlEl.textContent = stream.url;

  commandModal.classList.remove('hidden');
}

/**
 * Sets up button and search input listeners.
 */
function setupEventListeners() {
  tabBtnStreams.addEventListener('click', () => switchToTab('streams'));
  tabBtnDownloads.addEventListener('click', () => switchToTab('downloads'));

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderStreams();
    });
  });

  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderStreams();
  });

  const btnSidePanel = document.getElementById('btnSidePanel');
  if (btnSidePanel) {
    btnSidePanel.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.windowId && chrome.sidePanel?.open) {
        await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
        window.close();
      }
    });
  }

  btnRescan.addEventListener('click', async () => {
    if (!currentTabId) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        files: ['content/page-detector.js']
      });
      setTimeout(loadStreams, 300);
    } catch (err) {
      console.warn('Cannot inject into this page:', err);
      loadStreams();
    }
  });

  btnClear.addEventListener('click', async () => {
    if (!currentTabId) return;
    await chrome.runtime.sendMessage({
      action: 'CLEAR_TAB_STREAMS',
      tabId: currentTabId
    });
    activeStreams = [];
    renderStreams();
  });

  btnClearHistory.addEventListener('click', async () => {
    if (confirm('Clear all completed download history?')) {
      await chrome.runtime.sendMessage({ action: 'CLEAR_DOWNLOAD_HISTORY' });
      await loadDownloadHistory();
    }
  });

  btnCancelDownload.addEventListener('click', async () => {
    const streamUrl = btnCancelDownload.dataset.streamUrl;
    if (streamUrl) {
      await chrome.runtime.sendMessage({
        action: 'CANCEL_HLS_DOWNLOAD',
        streamUrl
      });
      await syncBackgroundDownloads();
    }
  });

  btnCloseModal.addEventListener('click', () => {
    commandModal.classList.add('hidden');
  });

  commandModal.addEventListener('click', (e) => {
    if (e.target === commandModal) {
      commandModal.classList.add('hidden');
    }
  });

  document.querySelectorAll('.btn-copy-code').forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.target;
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        await navigator.clipboard.writeText(targetEl.textContent);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      }
    });
  });
}

// Helpers
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return null;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return 'Just now';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)}m ago`;

  const d = new Date(timestamp);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', init);
