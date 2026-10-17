/**
 * Offscreen Background Downloader Engine: Runs independently of popup lifecycle.
 * Executes concurrent segment fetching, AES-128 decryption, and MP4 transmuxing.
 * Generates stream-level video previews from segment data.
 */

import { HlsDownloader } from '../lib/hls-downloader.js';

// Map of running downloaders: streamUrl -> HlsDownloader
const activeDownloaders = new Map();

/**
 * Extracts a thumbnail directly from an HLS stream manifest or video segment.
 */
async function generateStreamThumbnail(streamUrl) {
  try {
    const res = await fetch(streamUrl);
    if (!res.ok) return null;
    const text = await res.text();

    let segmentUrl = null;
    if (text.includes('#EXTM3U')) {
      if (text.includes('#EXT-X-STREAM-INF')) {
        // Master playlist, select first variant
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1]) {
            const variantRel = lines[i + 1].trim();
            const variantUrl = new URL(variantRel, streamUrl).href;
            const vRes = await fetch(variantUrl);
            const vText = await vRes.text();
            segmentUrl = extractFirstSegment(vText, variantUrl);
            break;
          }
        }
      } else {
        segmentUrl = extractFirstSegment(text, streamUrl);
      }
    }

    if (!segmentUrl) return null;

    const segRes = await fetch(segmentUrl);
    if (!segRes.ok) return null;
    const segBuffer = await segRes.arrayBuffer();

    let mp4Blob = null;
    // @ts-expect-error muxjs is loaded globally in downloader.html
    if (typeof muxjs !== 'undefined' && muxjs.mp4) {
      try {
        // @ts-expect-error muxjs is loaded globally in downloader.html
        const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
        const chunks = [];
        transmuxer.on('data', (segment) => {
          const data = new Uint8Array(segment.initSegment.byteLength + segment.data.byteLength);
          data.set(new Uint8Array(segment.initSegment), 0);
          data.set(new Uint8Array(segment.data), segment.initSegment.byteLength);
          chunks.push(data);
        });
        transmuxer.push(new Uint8Array(segBuffer));
        transmuxer.flush();
        if (chunks.length > 0) {
          mp4Blob = new Blob(chunks, { type: 'video/mp4' });
        }
      } catch (muxErr) {
        console.debug('Muxing segment for thumbnail failed:', muxErr);
      }
    }

    if (!mp4Blob) {
      mp4Blob = new Blob([segBuffer], { type: 'video/mp4' });
    }

    const blobUrl = URL.createObjectURL(mp4Blob);
    const thumbDataUrl = await captureFrameFromBlob(blobUrl);
    URL.revokeObjectURL(blobUrl);

    return thumbDataUrl;
  } catch (err) {
    console.debug('generateStreamThumbnail error:', err);
    return null;
  }
}

function extractFirstSegment(m3u8Text, baseUrl) {
  const lines = m3u8Text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      return new URL(trimmed, baseUrl).href;
    }
  }
  return null;
}

function captureFrameFromBlob(blobUrl) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';

    let resolved = false;
    const cleanup = () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };

    const done = (data) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(data);
      }
    };

    const timer = setTimeout(() => done(null), 3000);

    video.addEventListener('loadeddata', () => {
      try {
        video.currentTime = Math.min(0.5, video.duration > 0.5 ? 0.5 : 0);
      } catch {
        // ignore
      }
    });

    video.addEventListener('seeked', () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, 160, 90);
        done(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        done(null);
      }
    });

    video.addEventListener('error', () => {
      clearTimeout(timer);
      done(null);
    });

    video.src = blobUrl;
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'OFFSCREEN') return;

  if (message.action === 'START_DOWNLOAD_TASK') {
    const { stream, title, filename, options = {} } = message;
    if (activeDownloaders.has(stream.url)) {
      sendResponse({ success: false, error: 'Task already active' });
      return;
    }

    const downloader = new HlsDownloader({ concurrency: 4 });
    activeDownloaders.set(stream.url, downloader);

    let activeThumbnail = stream.thumbnail || null;
    if (!activeThumbnail) {
      generateStreamThumbnail(stream.url).then((thumb) => {
        if (thumb) {
          activeThumbnail = thumb;
          chrome.runtime.sendMessage({
            action: 'BACKGROUND_DOWNLOAD_PROGRESS',
            streamUrl: stream.url,
            title,
            filename,
            thumbnail: activeThumbnail,
            progress: { statusText: 'Downloading segments...' }
          }).catch(() => {});
        }
      });
    }

    downloader.downloadStream(stream.url, {
      ...options,
      onProgress: (p) => {
        chrome.runtime.sendMessage({
          action: 'BACKGROUND_DOWNLOAD_PROGRESS',
          streamUrl: stream.url,
          title,
          filename,
          thumbnail: activeThumbnail,
          progress: p
        }).catch(() => {});
      }
    }).then((result) => {
      const blobUrl = URL.createObjectURL(result.blob);
      const ext = (options.audioOnly || result.isAudio) ? 'm4a' : (result.isMp4 ? 'mp4' : 'ts');
      const finalFilename = `${filename}.${ext}`;

      chrome.runtime.sendMessage({
        action: 'BACKGROUND_DOWNLOAD_COMPLETE',
        streamUrl: stream.url,
        blobUrl,
        finalFilename,
        size: result.size,
        title,
        thumbnail: activeThumbnail,
        isMp4: result.isMp4,
        isAudio: options.audioOnly || result.isAudio
      }).catch(() => {});

      activeDownloaders.delete(stream.url);
    }).catch((err) => {
      chrome.runtime.sendMessage({
        action: 'BACKGROUND_DOWNLOAD_ERROR',
        streamUrl: stream.url,
        error: err.message
      }).catch(() => {});

      activeDownloaders.delete(stream.url);
    });

    sendResponse({ success: true });
  } else if (message.action === 'GENERATE_STREAM_THUMBNAIL') {
    generateStreamThumbnail(message.streamUrl).then((thumb) => {
      sendResponse({ success: true, thumbnail: thumb });
    });
    return true;
  } else if (message.action === 'CANCEL_DOWNLOAD_TASK') {
    const dl = activeDownloaders.get(message.streamUrl);
    if (dl) {
      dl.abort();
      activeDownloaders.delete(message.streamUrl);
    }
    sendResponse({ success: true });
  } else if (message.action === 'REVOKE_BLOB_URL') {
    if (message.blobUrl) {
      try {
        URL.revokeObjectURL(message.blobUrl);
      } catch {
        // Ignore
      }
    }
    sendResponse({ success: true });
  }

  return true;
});
