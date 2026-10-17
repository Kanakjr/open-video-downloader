/**
 * Content script to passively detect <video> and <audio> media elements on the page,
 * extract high-fidelity video titles, extract thumbnails, and report metadata to the extension.
 */

(() => {
  const reportedUrls = new Set();

  function cleanTitle(raw) {
    if (!raw || typeof raw !== 'string') return 'Video';

    let title = raw.trim();

    // Strip common site suffixes and branding
    title = title.replace(/\s*[-–—|]\s*(YouTube|Vimeo|Twitch|Twitter|X|Facebook|Instagram|TikTok|Dailymotion|Bilibili|Rumble|Odysee|Kick)\s*$/i, '');
    title = title.replace(/\s*[-–—|]\s*(Watch Online|Full Movie|Free Streaming|HD Video|Official Video|Official Audio)\s*$/i, '');

    // Strip invalid filename characters for cross-platform compatibility
    title = title.replace(/[<>:"/\\|?*]/g, '_');

    // Clean repeated spaces or underscores
    title = title.replace(/\s+/g, ' ').replace(/_+/g, '_').trim();

    if (title.length > 120) {
      title = title.substring(0, 120).trim();
    }

    return title || 'Video';
  }

  function extractBestTitle(mediaEl = null) {
    // 1. YouTube specific selectors
    const yt = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, ytd-watch-metadata #title h1, #title h1');
    if (yt && yt.textContent.trim()) {
      return cleanTitle(yt.textContent);
    }

    // 2. Vimeo specific selectors
    const vimeo = document.querySelector('.vp-video-header-title, h1.player-meta-title');
    if (vimeo && vimeo.textContent.trim()) {
      return cleanTitle(vimeo.textContent);
    }

    // 3. Media element title or aria-label
    if (mediaEl) {
      const mediaTitle = mediaEl.getAttribute('title') || mediaEl.getAttribute('aria-label');
      if (mediaTitle && mediaTitle.trim().length > 3) {
        return cleanTitle(mediaTitle);
      }
    }

    // 4. OpenGraph and Twitter title
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (ogTitle && ogTitle.trim()) {
      return cleanTitle(ogTitle);
    }

    const twitterTitle = document.querySelector('meta[name="twitter:title"]')?.getAttribute('content');
    if (twitterTitle && twitterTitle.trim()) {
      return cleanTitle(twitterTitle);
    }

    // 5. Main page H1 heading
    const h1 = document.querySelector('h1')?.textContent;
    if (h1 && h1.trim() && h1.trim().length > 3 && h1.trim().length < 150) {
      return cleanTitle(h1);
    }

    // 6. Page document title fallback
    return cleanTitle(document.title);
  }

  function extractThumbnail(mediaEl = null) {
    // 1. Check media element or any video element poster
    const videoElements = mediaEl ? [mediaEl] : Array.from(document.querySelectorAll('video'));
    for (const v of videoElements) {
      if (v.poster) {
        try {
          const abs = new URL(v.poster, window.location.href).href;
          if (abs.startsWith('http')) return abs;
        } catch {}
      }
    }

    // 2. YouTube specific thumbnail
    try {
      const urlObj = new URL(window.location.href);
      if (urlObj.hostname.includes('youtube.com')) {
        const v = urlObj.searchParams.get('v');
        if (v) return `https://i.ytimg.com/vi/${v}/hqdefault.jpg`;
      }
    } catch {}

    // 3. Vimeo thumbnail
    const vimeoThumb = document.querySelector('#vp-preview')?.getAttribute('data-thumb');
    if (vimeoThumb) {
      try {
        const abs = new URL(vimeoThumb, window.location.href).href;
        if (abs.startsWith('http')) return abs;
      } catch {}
    }

    // 4. Video player custom poster overlays (Video.js, JW Player, Plyr, etc.)
    const playerSelectors = [
      '.vjs-poster',
      '.jw-preview',
      '.plyr__poster',
      '.fp-poster',
      '[class*="poster" i]',
      '[class*="player-thumb" i]',
      '[class*="thumbnail-wrapper" i] img',
      'ytd-player #thumbnail img',
      'yt-img-shadow img'
    ];
    for (const sel of playerSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          if (el.tagName === 'IMG' && el.src && el.src.startsWith('http')) {
            return el.src;
          }
          const bg = window.getComputedStyle(el).backgroundImage;
          if (bg && bg !== 'none') {
            const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
            if (match && match[1]) {
              const abs = new URL(match[1], window.location.href).href;
              if (abs.startsWith('http')) return abs;
            }
          }
        }
      } catch {}
    }

    // 5. OpenGraph, Twitter, and Schema meta tags
    const metaSelectors = [
      'meta[property="og:image"]',
      'meta[property="og:image:url"]',
      'meta[property="og:image:secure_url"]',
      'meta[name="og:image"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:src"]',
      'meta[itemprop="thumbnailUrl"]',
      'meta[itemprop="image"]',
      'link[rel="image_src"]',
      'link[rel="thumbnail"]'
    ];
    for (const sel of metaSelectors) {
      const el = document.querySelector(sel);
      const val = el?.getAttribute('content') || el?.getAttribute('href');
      if (val) {
        try {
          const abs = new URL(val, window.location.href).href;
          if (abs.startsWith('http')) return abs;
        } catch {}
      }
    }

    // 6. Canvas frame capture if any video element is playing with loaded frames
    for (const v of videoElements) {
      if (v.videoWidth > 0 && v.videoHeight > 0 && v.currentTime > 0) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 160;
          canvas.height = 90;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL('image/jpeg', 0.65);
          if (data && data.length > 500) return data;
        } catch {
          // Tainted canvas on cross-origin video without CORS, continue
        }
      }
    }

    return null;
  }

  function reportMedia(url, mediaEl = null) {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('javascript:')) {
      if (!mediaEl || !mediaEl.videoWidth) return;
    }

    if (reportedUrls.has(url)) return;
    reportedUrls.add(url);

    let width = null;
    let height = null;
    let duration = null;

    if (mediaEl) {
      if (mediaEl.videoWidth && mediaEl.videoHeight) {
        width = mediaEl.videoWidth;
        height = mediaEl.videoHeight;
      }
      if (mediaEl.duration && !isNaN(mediaEl.duration) && isFinite(mediaEl.duration)) {
        duration = Math.round(mediaEl.duration);
      }
    }

    const currentTitle = extractBestTitle(mediaEl);
    const thumbnail = extractThumbnail(mediaEl);

    const payload = {
      action: 'MEDIA_DETECTED_PAGE',
      stream: {
        url,
        title: currentTitle,
        thumbnail,
        pageUrl: window.location.href,
        width,
        height,
        duration,
        detectedAt: Date.now(),
        source: 'dom_element'
      }
    };

    try {
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch {
      // Context invalidated
    }
  }

  function sendPageMetadata(mediaEl = null) {
    const title = extractBestTitle(mediaEl);
    const thumbnail = extractThumbnail(mediaEl);

    try {
      chrome.runtime.sendMessage({
        action: 'PAGE_METADATA_UPDATE',
        title,
        thumbnail,
        pageUrl: window.location.href
      }).catch(() => {});
    } catch {
      // Context invalidated
    }
  }

  function scanElements() {
    const videos = document.querySelectorAll('video, audio');
    videos.forEach((media) => {
      if (media.src) reportMedia(media.src, media);
      if (media.currentSrc) reportMedia(media.currentSrc, media);

      const sources = media.querySelectorAll('source');
      sources.forEach((source) => {
        if (source.src) reportMedia(source.src, media);
      });

      media.addEventListener('loadedmetadata', () => {
        const src = media.currentSrc || media.src;
        if (src) reportMedia(src, media);
        sendPageMetadata(media);
      }, { once: true });

      media.addEventListener('loadeddata', () => {
        sendPageMetadata(media);
      }, { once: true });

      media.addEventListener('play', () => {
        const src = media.currentSrc || media.src;
        if (src) reportMedia(src, media);
        sendPageMetadata(media);
      }, { once: true });

      let lastThumbCapture = 0;
      media.addEventListener('timeupdate', () => {
        const now = Date.now();
        if (now - lastThumbCapture > 3000 && media.currentTime > 0.5) {
          lastThumbCapture = now;
          const thumb = extractThumbnail(media);
          if (thumb) {
            sendPageMetadata(media);
          }
        }
      });
    });

    const ogVideo = document.querySelector('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]');
    if (ogVideo) {
      const content = ogVideo.getAttribute('content');
      if (content && content.startsWith('http')) {
        reportMedia(content);
      }
    }
  }

  // Scan immediately
  scanElements();
  sendPageMetadata();

  // Also send metadata on page title change
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(() => sendPageMetadata()).observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  // Observe DOM additions
  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) {
            if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO' || node.querySelector?.('video, audio')) {
              shouldScan = true;
              break;
            }
          }
        }
      }
      if (shouldScan) break;
    }
    if (shouldScan) {
      scanElements();
    }
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
  });

  // Handle active video bounds query from popup/service worker
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'GET_ACTIVE_VIDEO_RECT') {
      const videos = Array.from(document.querySelectorAll('video'));
      let bestVideo = null;
      let maxArea = 0;
      for (const v of videos) {
        const rect = v.getBoundingClientRect();
        const isVisible = rect.width > 40 && rect.height > 40 &&
          rect.bottom > 0 && rect.top < window.innerHeight &&
          rect.right > 0 && rect.left < window.innerWidth;
        const area = rect.width * rect.height;
        if (isVisible && area > maxArea) {
          maxArea = area;
          bestVideo = { v, rect };
        }
      }

      if (bestVideo) {
        const { rect } = bestVideo;
        sendResponse({
          success: true,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            dpr: window.devicePixelRatio || 1
          }
        });
      } else {
        sendResponse({ success: false });
      }
      return true;
    } else if (message.action === 'REQUEST_PAGE_THUMBNAIL') {
      const title = extractBestTitle();
      const thumbnail = extractThumbnail();
      sendResponse({ success: true, title, thumbnail });
      return true;
    }
  });
})();
