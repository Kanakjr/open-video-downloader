/**
 * Background Service Worker: Handles network sniffing via webRequest,
 * stream deduplication (grouping master & variant HLS playlists),
 * offscreen background downloading that survives tab switching & popup closing,
 * thumbnail tracking, and download history.
 */

import { cleanTitle, parseMasterPlaylist, isMasterPlaylist } from '../lib/hls-parser.js';

// In-memory stream catalog: Map<tabId, Map<streamUrl, StreamObject>>
const tabStreams = new Map();
// Tab metadata cache: Map<tabId, string>
const tabTitles = new Map();
const tabThumbnails = new Map();

// Active background downloads: Map<streamUrl, DownloadState>
const activeBackgroundDownloads = new Map();

let creatingOffscreenPromise = null;

const AD_DOMAIN_PATTERNS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleads.g.doubleclick.net',
  'adservice.google.com',
  'adnxs.com',
  'advertising.com',
  'taboola.com',
  'outbrain.com',
  'criteo.com',
  'scorecardresearch.com',
  'amazon-adsystem.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'adsafeprotected.com',
  'adcolony.com'
];

function isAdOrTrackerUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return AD_DOMAIN_PATTERNS.some(domain => hostname.includes(domain));
  } catch {
    return false;
  }
}

/**
 * Proactively fetches master playlist to extract video variants, audio tracks, and subtitles.
 */
async function enrichHlsStream(tabId, streamUrl) {
  try {
    const res = await fetch(streamUrl);
    if (!res.ok) return;
    const text = await res.text();
    if (isMasterPlaylist(text)) {
      const variants = parseMasterPlaylist(text, streamUrl);
      const streams = tabStreams.get(tabId);
      if (streams) {
        for (const [url, item] of streams.entries()) {
          if (url === streamUrl || item.groupKey === getStreamGroupingKey(streamUrl)) {
            item.variants = variants;
            item.audioTracks = variants.audioTracks || [];
            item.subtitles = variants.subtitles || [];
            if (variants[0]?.resolution) {
              item.resolution = variants[0].resolution;
            }
            streams.set(url, item);
          }
        }
      }
    }
  } catch {
    // Ignore fetch errors
  }
}

/**
 * Ensures the offscreen document is created for background downloading.
 */
async function ensureOffscreenDocument() {
  if (await chrome.offscreen?.hasDocument?.()) return;

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: 'background/downloader.html',
    reasons: ['BLOBS', 'WORKERS'],
    justification: 'In-browser video downloading and MP4 transmuxing.'
  });

  try {
    await creatingOffscreenPromise;
  } catch (err) {
    if (!err.message?.includes('Only a single offscreen document may be created')) {
      throw err;
    }
  } finally {
    creatingOffscreenPromise = null;
  }
}

/**
 * Normalizes URL and groups variants under the same stream directory.
 */
function getStreamGroupingKey(streamUrl) {
  try {
    const u = new URL(streamUrl);
    let pathname = u.pathname;
    if (pathname.endsWith('.m3u8')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length > 1) {
        parts.pop();
        pathname = '/' + parts.join('/');
      }
    }
    return `${u.origin}${pathname}`.toLowerCase();
  } catch {
    return streamUrl.split('?')[0].toLowerCase();
  }
}

/**
 * Normalizes and categorizes media streams by URL, MIME type, and headers.
 */
function inspectMediaResponse(details) {
  const url = details.url;
  if (!url || !url.startsWith('http')) return null;

  if (url.includes('chrome-extension://') || url.includes('moz-extension://')) return null;

  // Filter out known advertising and tracker domains
  if (isAdOrTrackerUrl(url)) return null;

  const cleanUrl = url.split('?')[0].toLowerCase();
  if (cleanUrl.endsWith('.ts') || cleanUrl.endsWith('.m4s') || cleanUrl.endsWith('.m2ts')) {
    return null;
  }

  let contentType = '';
  let contentLength = 0;
  let contentDisposition = '';

  if (details.responseHeaders) {
    for (const h of details.responseHeaders) {
      const name = h.name.toLowerCase();
      if (name === 'content-type') contentType = (h.value || '').toLowerCase();
      else if (name === 'content-length') contentLength = parseInt(h.value || '0', 10) || 0;
      else if (name === 'content-disposition') contentDisposition = h.value || '';
    }
  }

  let type = null;
  let format = 'unknown';

  // 1. Check for HLS (m3u8)
  if (
    contentType.includes('mpegurl') ||
    contentType.includes('application/x-mpegurl') ||
    contentType.includes('application/vnd.apple.mpegurl') ||
    cleanUrl.endsWith('.m3u8') ||
    url.includes('.m3u8?')
  ) {
    type = 'hls';
    format = 'HLS (.m3u8)';
  }
  // 2. Check for DASH (mpd)
  else if (
    contentType.includes('dash+xml') ||
    cleanUrl.endsWith('.mpd') ||
    url.includes('.mpd?')
  ) {
    type = 'dash';
    format = 'DASH (.mpd)';
  }
  // 3. Check for Direct Progressive Video
  else if (contentType.startsWith('video/')) {
    if (contentLength > 0 && contentLength < 300 * 1024) return null;
    type = 'direct_video';
    const sub = contentType.split(';')[0].replace('video/', '').toUpperCase();
    format = sub || 'MP4';
  }
  // 4. Check for Direct Audio
  else if (contentType.startsWith('audio/')) {
    if (contentLength > 0 && contentLength < 100 * 1024) return null;
    type = 'direct_audio';
    const sub = contentType.split(';')[0].replace('audio/', '').toUpperCase();
    format = sub || 'AUDIO';
  }
  // 5. Check URL extension fallback
  else if (cleanUrl.match(/\.(mp4|webm|mkv|mov|flv|m4v)(\?|$)/i)) {
    type = 'direct_video';
    format = cleanUrl.match(/\.(mp4|webm|mkv|mov|flv|m4v)/i)[1].toUpperCase();
  } else if (cleanUrl.match(/\.(mp3|m4a|aac|ogg|wav|opus)(\?|$)/i)) {
    type = 'direct_audio';
    format = cleanUrl.match(/\.(mp3|m4a|aac|ogg|wav|opus)/i)[1].toUpperCase();
  }

  if (!type) return null;

  let filename = '';
  if (contentDisposition) {
    const fnMatch = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
    if (fnMatch && fnMatch[1]) {
      try {
        filename = decodeURIComponent(fnMatch[1]);
      } catch {
        filename = fnMatch[1];
      }
    }
  }

  let title = tabTitles.get(details.tabId) || '';
  if (!title && filename) {
    title = cleanTitle(filename);
  }

  const isAdaptive = type === 'hls' || type === 'dash';
  const size = isAdaptive ? null : (contentLength > 0 ? contentLength : null);

  return {
    url,
    type,
    format,
    size,
    isAdaptive,
    filename: filename || 'video',
    title: title || '',
    thumbnail: tabThumbnails.get(details.tabId) || null,
    groupKey: getStreamGroupingKey(url),
    initiator: details.initiator || '',
    detectedAt: Date.now(),
    source: 'network'
  };
}

/**
 * Registers a detected stream for a given tab, deduplicating HLS variants.
 */
function recordStream(tabId, streamData) {
  if (!tabId || tabId < 0) return;

  if (!tabStreams.has(tabId)) {
    tabStreams.set(tabId, new Map());
  }

  const streamsForTab = tabStreams.get(tabId);
  const knownTabTitle = tabTitles.get(tabId);
  const knownThumbnail = tabThumbnails.get(tabId);

  let resolvedTitle = streamData.title;
  if (!resolvedTitle || resolvedTitle === 'video' || resolvedTitle.endsWith('.m3u8') || resolvedTitle.endsWith('.mpd')) {
    resolvedTitle = knownTabTitle || streamData.filename || 'Video Stream';
  }

  const streamToInsert = {
    ...streamData,
    title: resolvedTitle,
    thumbnail: streamData.thumbnail || knownThumbnail || null,
    groupKey: streamData.groupKey || getStreamGroupingKey(streamData.url)
  };

  let duplicateKey = null;
  for (const [existingUrl, existingStream] of streamsForTab.entries()) {
    if (existingUrl === streamData.url) {
      duplicateKey = existingUrl;
      break;
    }
    if (streamData.type === 'hls' && existingStream.type === 'hls' && existingStream.groupKey === streamToInsert.groupKey) {
      duplicateKey = existingUrl;
      break;
    }
  }

  if (duplicateKey) {
    const existing = streamsForTab.get(duplicateKey);
    const isIncomingMaster = streamData.url.toLowerCase().includes('master');
    const targetUrl = isIncomingMaster ? streamData.url : duplicateKey;

    if (isIncomingMaster && targetUrl !== duplicateKey) {
      streamsForTab.delete(duplicateKey);
    }

    streamsForTab.set(targetUrl, {
      ...existing,
      ...streamToInsert,
      url: targetUrl,
      title: resolvedTitle || existing.title,
      thumbnail: streamToInsert.thumbnail || existing.thumbnail,
      duration: streamData.duration || existing.duration,
      width: streamData.width || existing.width,
      height: streamData.height || existing.height
    });
  } else {
    streamsForTab.set(streamData.url, streamToInsert);
  }

  updateActionBadge(tabId);
}

/**
 * Updates action icon badge text for a tab.
 */
async function updateActionBadge(tabId) {
  try {
    // If there is an active background download running, prioritize download percentage
    if (activeBackgroundDownloads.size > 0) {
      const first = Array.from(activeBackgroundDownloads.values())[0];
      const pct = first.progress?.percent || 0;
      await chrome.action.setBadgeText({ text: `${pct}%` });
      await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
      return;
    }

    const streams = tabStreams.get(tabId);
    const count = streams ? streams.size : 0;
    const text = count > 0 ? (count > 99 ? '99+' : count.toString()) : '';
    await chrome.action.setBadgeText({ tabId, text });
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
    }
  } catch {
    // Tab inactive or closed
  }
}

// Sniff network responses
chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (details.statusCode < 200 || details.statusCode >= 300) return;

    if (details.tabId > 0 && !tabTitles.has(details.tabId)) {
      try {
        const tab = await chrome.tabs.get(details.tabId);
        if (tab && tab.title) {
          tabTitles.set(details.tabId, cleanTitle(tab.title));
        }
      } catch {
        // Tab not accessible
      }
    }

    const stream = inspectMediaResponse(details);
    if (stream) {
      recordStream(details.tabId, stream);

      if (stream.type === 'hls' && details.tabId > 0) {
        enrichHlsStream(details.tabId, stream.url);
      }

      if (details.tabId > 0 && !tabThumbnails.has(details.tabId)) {
        chrome.tabs.sendMessage(details.tabId, { action: 'REQUEST_PAGE_THUMBNAIL' })
          .then((res) => {
            if (res && res.thumbnail) {
              tabThumbnails.set(details.tabId, res.thumbnail);
              const streams = tabStreams.get(details.tabId);
              if (streams) {
                for (const [url, item] of streams.entries()) {
                  if (!item.thumbnail) {
                    item.thumbnail = res.thumbnail;
                    streams.set(url, item);
                  }
                }
              }
            }
          }).catch(() => {});
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Tab cleanup & navigation handling
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title) {
    tabTitles.set(tabId, cleanTitle(changeInfo.title));
    const streams = tabStreams.get(tabId);
    if (streams) {
      for (const [url, item] of streams.entries()) {
        if (!item.title || item.title === 'video' || item.title.endsWith('.m3u8')) {
          item.title = cleanTitle(changeInfo.title);
          streams.set(url, item);
        }
      }
    }
  }

  if (changeInfo.status === 'loading' && changeInfo.url) {
    tabStreams.delete(tabId);
    tabThumbnails.delete(tabId);
    updateActionBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreams.delete(tabId);
  tabTitles.delete(tabId);
  tabThumbnails.delete(tabId);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  updateActionBadge(activeInfo.tabId);
});

// Helper for persistent download history
async function getDownloadHistory() {
  const data = await chrome.storage.local.get('download_history');
  return Array.isArray(data.download_history) ? data.download_history : [];
}

async function saveDownloadHistory(history) {
  await chrome.storage.local.set({ download_history: history.slice(0, 100) });
}

// Message listener for popup, content scripts, and offscreen downloader
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.action === 'GET_TAB_STREAMS') {
        const tabId = message.tabId;
        const streamsMap = tabStreams.get(tabId);
        const streams = streamsMap ? Array.from(streamsMap.values()) : [];
        sendResponse({ success: true, streams });
      } else if (message.action === 'CLEAR_TAB_STREAMS') {
        const tabId = message.tabId;
        tabStreams.delete(tabId);
        await updateActionBadge(tabId);
        sendResponse({ success: true });
      } else if (message.action === 'PAGE_METADATA_UPDATE') {
        const tabId = sender.tab?.id;
        if (tabId) {
          if (message.title) tabTitles.set(tabId, cleanTitle(message.title));
          if (message.thumbnail) tabThumbnails.set(tabId, message.thumbnail);

          const streams = tabStreams.get(tabId);
          if (streams) {
            for (const [url, item] of streams.entries()) {
              if (!item.title || item.title === 'video' || item.title.endsWith('.m3u8')) {
                item.title = cleanTitle(message.title);
              }
              if (!item.thumbnail && message.thumbnail) {
                item.thumbnail = message.thumbnail;
              }
              streams.set(url, item);
            }
          }
        }
        sendResponse({ success: true });
      } else if (message.action === 'MEDIA_DETECTED_PAGE') {
        const tabId = sender.tab?.id;
        if (tabId && message.stream) {
          if (message.stream.title) tabTitles.set(tabId, cleanTitle(message.stream.title));
          if (message.stream.thumbnail) tabThumbnails.set(tabId, message.stream.thumbnail);

          const stream = {
            ...message.stream,
            title: cleanTitle(message.stream.title || tabTitles.get(tabId) || 'Video'),
            thumbnail: message.stream.thumbnail || tabThumbnails.get(tabId) || null,
            format: message.stream.url.includes('.m3u8') ? 'HLS (.m3u8)' : (message.stream.format || 'HTML5 Video'),
            type: message.stream.url.includes('.m3u8') ? 'hls' : 'direct_video'
          };
          recordStream(tabId, stream);
        }
        sendResponse({ success: true });
      }

      // --- Background Download Operations ---
      else if (message.action === 'START_HLS_DOWNLOAD') {
        const { stream, title, filename, options = {} } = message;
        await ensureOffscreenDocument();

        const activeThumb = stream.thumbnail || (stream.tabId ? tabThumbnails.get(stream.tabId) : null) || null;

        activeBackgroundDownloads.set(stream.url, {
          streamUrl: stream.url,
          title: title || cleanTitle(stream.title || 'Video'),
          filename: filename || 'video',
          thumbnail: activeThumb,
          progress: { percent: 0, statusText: 'Starting background download...' }
        });

        await chrome.action.setBadgeText({ text: '0%' });
        await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });

        // Forward to offscreen document
        chrome.runtime.sendMessage({
          target: 'OFFSCREEN',
          action: 'START_DOWNLOAD_TASK',
          stream: { ...stream, thumbnail: activeThumb },
          title,
          filename,
          options
        }).catch(() => {});

        sendResponse({ success: true });
      } else if (message.action === 'CANCEL_HLS_DOWNLOAD') {
        const { streamUrl } = message;
        activeBackgroundDownloads.delete(streamUrl);

        if (activeBackgroundDownloads.size === 0) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab?.id) await updateActionBadge(activeTab.id);
          else await chrome.action.setBadgeText({ text: '' });
        }

        chrome.runtime.sendMessage({
          target: 'OFFSCREEN',
          action: 'CANCEL_DOWNLOAD_TASK',
          streamUrl
        }).catch(() => {});

        sendResponse({ success: true });
      } else if (message.action === 'GET_ACTIVE_DOWNLOADS') {
        sendResponse({
          success: true,
          downloads: Array.from(activeBackgroundDownloads.values())
        });
      } else if (message.action === 'UPDATE_STREAM_THUMBNAIL') {
        const { tabId, streamUrl, thumbnail } = message;
        if (thumbnail) {
          if (tabId) tabThumbnails.set(tabId, thumbnail);
          const streams = tabId ? tabStreams.get(tabId) : null;
          if (streams) {
            for (const [url, item] of streams.entries()) {
              if (!streamUrl || url === streamUrl || item.groupKey === getStreamGroupingKey(streamUrl)) {
                item.thumbnail = thumbnail;
                streams.set(url, item);
              }
            }
          }
        }
        sendResponse({ success: true });
      }

      // --- Messages From Offscreen Downloader ---
      else if (message.action === 'BACKGROUND_DOWNLOAD_PROGRESS') {
        const { streamUrl, title, filename, thumbnail, progress } = message;
        const existing = activeBackgroundDownloads.get(streamUrl) || {};
        const resolvedThumb = thumbnail || existing.thumbnail || null;

        activeBackgroundDownloads.set(streamUrl, {
          streamUrl,
          title: title || existing.title,
          filename: filename || existing.filename,
          thumbnail: resolvedThumb,
          progress
        });

        if (resolvedThumb) {
          for (const streams of tabStreams.values()) {
            const item = streams.get(streamUrl);
            if (item && !item.thumbnail) {
              item.thumbnail = resolvedThumb;
              streams.set(streamUrl, item);
            }
          }
        }

        // Update badge with percentage
        const pct = progress.percent !== undefined ? progress.percent : 0;
        await chrome.action.setBadgeText({ text: `${pct}%` });
        await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });

        sendResponse({ success: true });
      } else if (message.action === 'BACKGROUND_DOWNLOAD_COMPLETE') {
        const { streamUrl, blobUrl, finalFilename, size, title, thumbnail, isMp4 } = message;
        const existing = activeBackgroundDownloads.get(streamUrl);
        const resolvedThumb = thumbnail || existing?.thumbnail || null;

        activeBackgroundDownloads.delete(streamUrl);

        if (activeBackgroundDownloads.size === 0) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab?.id) await updateActionBadge(activeTab.id);
          else await chrome.action.setBadgeText({ text: '' });
        }

        // Trigger native download
        const downloadId = await chrome.downloads.download({
          url: blobUrl,
          filename: finalFilename,
          saveAs: true
        });

        // Record to persistent history
        const history = await getDownloadHistory();
        history.unshift({
          id: `dl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          downloadId,
          title: title || finalFilename,
          filename: finalFilename,
          size,
          thumbnail: resolvedThumb || null,
          timestamp: Date.now(),
          type: isMp4 ? 'MP4' : 'TS'
        });
        await saveDownloadHistory(history);

        // Revoke blob URL after 60 seconds
        setTimeout(() => {
          chrome.runtime.sendMessage({
            target: 'OFFSCREEN',
            action: 'REVOKE_BLOB_URL',
            blobUrl
          }).catch(() => {});
        }, 60000);

        sendResponse({ success: true, downloadId });
      } else if (message.action === 'BACKGROUND_DOWNLOAD_ERROR') {
        const { streamUrl } = message;
        activeBackgroundDownloads.delete(streamUrl);

        if (activeBackgroundDownloads.size === 0) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab?.id) await updateActionBadge(activeTab.id);
          else await chrome.action.setBadgeText({ text: '' });
        }

        sendResponse({ success: true });
      }

      // --- Direct Downloads & History Management ---
      else if (message.action === 'DOWNLOAD_DIRECT') {
        const { url, filename, title, thumbnail } = message;
        const cleanFn = filename ? filename.replace(/[<>:"/\\|?*]/g, '_').trim() : 'video.mp4';
        const downloadId = await chrome.downloads.download({
          url,
          filename: cleanFn,
          saveAs: true
        });

        const history = await getDownloadHistory();
        history.unshift({
          id: `dl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          downloadId,
          title: title || cleanFn,
          filename: cleanFn,
          thumbnail: thumbnail || null,
          timestamp: Date.now(),
          type: 'direct'
        });
        await saveDownloadHistory(history);

        sendResponse({ success: true, downloadId });
      } else if (message.action === 'GET_DOWNLOAD_HISTORY') {
        const history = await getDownloadHistory();
        sendResponse({ success: true, history });
      } else if (message.action === 'REMOVE_DOWNLOAD_HISTORY_ITEM') {
        let history = await getDownloadHistory();
        history = history.filter(h => h.id !== message.id);
        await saveDownloadHistory(history);
        sendResponse({ success: true });
      } else if (message.action === 'CLEAR_DOWNLOAD_HISTORY') {
        await saveDownloadHistory([]);
        sendResponse({ success: true });
      } else if (message.action === 'OPEN_DOWNLOAD_FOLDER') {
        if (message.downloadId) {
          chrome.downloads.show(message.downloadId);
        }
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});

// Setup context menus
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: 'ctx_download_media',
      title: 'Download Video with Open Video Downloader',
      contexts: ['video', 'audio']
    });

    chrome.contextMenus.create({
      id: 'ctx_open_sidepanel',
      title: 'Open Downloader in Side Panel',
      contexts: ['page', 'action']
    });
  } catch {
    // Context menus already exist
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'ctx_download_media' && info.srcUrl) {
    const filename = cleanTitle(tab?.title || 'video');
    await chrome.downloads.download({
      url: info.srcUrl,
      filename: `${filename}.mp4`,
      saveAs: true
    }).catch(() => {});
  } else if (info.menuItemId === 'ctx_open_sidepanel' && tab?.windowId) {
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    }
  }
});
