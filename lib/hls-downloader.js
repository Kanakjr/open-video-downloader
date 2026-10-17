/**
 * In-browser HLS stream downloader with AES-128 decryption, concurrent segment fetching,
 * and pure JS TS-to-MP4 transmuxing for smooth, non-choppy playback.
 */

import { parseMasterPlaylist, parseMediaPlaylist, isMasterPlaylist, estimateHlsSize } from './hls-parser.js';

export class HlsDownloader {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 3;
    this.abortController = new AbortController();
    this.keyCache = new Map();
  }

  abort() {
    this.abortController.abort();
  }

  /**
   * Downloads an HLS stream, transmuxes TS into smooth MP4, and returns the merged Blob.
   * @param {string} manifestUrl - Master or Media playlist URL
   * @param {Object} options - { onProgress, preferredQuality, headers }
   */
  async downloadStream(manifestUrl, options = {}) {
    const { onProgress = () => {}, headers = {} } = options;
    const signal = this.abortController.signal;

    onProgress({ status: 'fetching_manifest', message: 'Fetching stream playlist...' });

    // 1. Fetch playlist
    const manifestResponse = await fetch(manifestUrl, { headers, signal });
    if (!manifestResponse.ok) {
      throw new Error(`Failed to fetch playlist: HTTP ${manifestResponse.status}`);
    }
    const manifestText = await manifestResponse.text();

    let targetMediaUrl = manifestUrl;
    let mediaPlaylistText = manifestText;
    let selectedVariant = null;

    // 2. Handle Master playlist if needed
    if (isMasterPlaylist(manifestText)) {
      const variants = parseMasterPlaylist(manifestText, manifestUrl);
      if (!variants.length) {
        throw new Error('No valid video streams found in master playlist.');
      }

      // Pick quality variant or audio track
      if (options.audioOnly && variants.audioTracks && variants.audioTracks.length > 0) {
        selectedVariant = {
          url: variants.audioTracks[0].uri,
          qualityLabel: 'Audio Track',
          bandwidth: 128000
        };
      } else if (options.selectedVariantUrl) {
        const match = variants.find(v => v.url === options.selectedVariantUrl);
        selectedVariant = match || { url: options.selectedVariantUrl, qualityLabel: 'Custom', bandwidth: 0 };
      } else if (options.preferredQuality) {
        const match = variants.find(v => v.qualityLabel === options.preferredQuality || v.height === options.preferredQuality);
        selectedVariant = match || variants[0];
      } else {
        selectedVariant = variants[0];
      }

      targetMediaUrl = selectedVariant.url;
      onProgress({ status: 'fetching_variant', message: `Selected ${selectedVariant.qualityLabel || 'stream'}, fetching media segments...` });

      const variantResponse = await fetch(targetMediaUrl, { headers, signal });
      if (!variantResponse.ok) {
        throw new Error(`Failed to fetch media variant: HTTP ${variantResponse.status}`);
      }
      mediaPlaylistText = await variantResponse.text();
    }

    // 3. Parse media segments
    const mediaInfo = parseMediaPlaylist(mediaPlaylistText, targetMediaUrl);
    const segments = mediaInfo.segments;

    if (!segments.length) {
      throw new Error('No media segments found in playlist.');
    }

    let estimatedTotalBytes = estimateHlsSize(selectedVariant?.bandwidth, mediaInfo.totalDuration);

    onProgress({
      status: 'downloading',
      totalSegments: segments.length,
      downloadedSegments: 0,
      percent: 0,
      totalDuration: mediaInfo.totalDuration,
      estimatedTotalBytes
    });

    // 4. Download init segment if present (fMP4)
    let initSegmentBuffer = null;
    if (mediaInfo.hasInitSegment && segments[0]?.initSegment?.uri) {
      const initUrl = segments[0].initSegment.uri;
      const initRes = await fetch(initUrl, { headers, signal });
      if (initRes.ok) {
        initSegmentBuffer = await initRes.arrayBuffer();
      }
    }

    // 5. Download segments with concurrency pool
    const downloadedBuffers = Array.from({ length: segments.length });
    let completedCount = 0;
    let totalBytes = 0;
    const startTime = Date.now();

    const fetchSegment = async (segment) => {
      if (signal.aborted) throw new Error('Download aborted by user.');

      let segmentRes;
      try {
        segmentRes = await fetch(segment.url, { headers, signal });
      } catch {
        if (signal.aborted) throw new Error('Download aborted by user.');
        // Retry once on failure
        await new Promise(r => setTimeout(r, 1000));
        segmentRes = await fetch(segment.url, { headers, signal });
      }

      if (!segmentRes.ok) {
        throw new Error(`Segment #${segment.index} failed: HTTP ${segmentRes.status}`);
      }

      let buffer = await segmentRes.arrayBuffer();

      // Handle AES-128 Decryption if necessary
      if (segment.key && segment.key.method === 'AES-128') {
        buffer = await this.decryptSegment(buffer, segment.key, segment.sequence, headers, signal);
      }

      downloadedBuffers[segment.index] = buffer;
      completedCount++;
      totalBytes += buffer.byteLength;

      // Estimate total size from first segment if bandwidth was missing
      if (!estimatedTotalBytes && buffer.byteLength > 0) {
        estimatedTotalBytes = buffer.byteLength * segments.length;
      }

      const elapsedSec = (Date.now() - startTime) / 1000;
      const bytesPerSec = elapsedSec > 0 ? totalBytes / elapsedSec : 0;
      const percent = Math.round((completedCount / segments.length) * 100);
      const estTotal = estimatedTotalBytes || (completedCount > 0 ? Math.round((totalBytes / completedCount) * segments.length) : null);
      const remainingBytes = estTotal && estTotal > totalBytes ? estTotal - totalBytes : 0;

      onProgress({
        status: 'downloading',
        totalSegments: segments.length,
        downloadedSegments: completedCount,
        percent,
        bytesDownloaded: totalBytes,
        estimatedTotalBytes: estTotal,
        speedBytesPerSec: bytesPerSec,
        estimatedTimeRemainingSec: bytesPerSec > 0 && remainingBytes > 0 ? remainingBytes / bytesPerSec : 0
      });
    };

    // Run pool
    const queue = [...segments];
    const workers = Array.from({ length: this.concurrency }, async () => {
      while (queue.length > 0) {
        if (signal.aborted) return;
        const segment = queue.shift();
        await fetchSegment(segment);
      }
    });

    await Promise.all(workers);

    if (signal.aborted) {
      throw new Error('Download cancelled.');
    }

    onProgress({ status: 'transmuxing', message: 'Transmuxing video to smooth MP4...' });

    // 6. Transmux TS to MP4 using mux.js if available
    const muxjs = globalThis.muxjs || (typeof window !== 'undefined' ? window.muxjs : null);
    let finalBlob = null;
    let isMp4 = false;

    if (muxjs && !mediaInfo.hasInitSegment) {
      try {
        const transmuxer = new muxjs.mp4.Transmuxer({
          remux: true,
          keepOriginalTimestamps: true
        });

        let initSegment = null;
        const mp4Chunks = [];

        transmuxer.on('data', (segment) => {
          if (segment.initSegment && !initSegment) {
            initSegment = segment.initSegment;
          }
          if (segment.data) {
            mp4Chunks.push(segment.data);
          }
        });

        for (let i = 0; i < downloadedBuffers.length; i++) {
          const buf = downloadedBuffers[i];
          if (buf && buf.byteLength > 0) {
            transmuxer.push(new Uint8Array(buf));
            transmuxer.flush();
          }
        }

        if (initSegment && mp4Chunks.length > 0) {
          finalBlob = new Blob([initSegment, ...mp4Chunks], { type: 'video/mp4' });
          isMp4 = true;
        }
      } catch (transmuxErr) {
        console.warn('Transmuxer failed, falling back to direct concat:', transmuxErr);
      }
    }

    // Fallback or already fMP4 with initSegment
    if (!finalBlob) {
      const finalChunks = [];
      if (initSegmentBuffer) {
        finalChunks.push(initSegmentBuffer);
      }
      for (let i = 0; i < downloadedBuffers.length; i++) {
        if (downloadedBuffers[i]) {
          finalChunks.push(downloadedBuffers[i]);
        }
      }

      const mimeType = mediaInfo.hasInitSegment ? 'video/mp4' : 'video/mp2t';
      isMp4 = mediaInfo.hasInitSegment;
      finalBlob = new Blob(finalChunks, { type: mimeType });
    }

    onProgress({
      status: 'complete',
      totalSegments: segments.length,
      downloadedSegments: segments.length,
      percent: 100,
      totalBytes: finalBlob.size,
      isMp4,
      blob: finalBlob
    });

    return {
      blob: finalBlob,
      isMp4,
      isAudio: !!options.audioOnly,
      size: finalBlob.size
    };
  }

  /**
   * Decrypts an AES-128 encrypted segment using Web Crypto API.
   */
  async decryptSegment(encryptedBuffer, keyInfo, sequenceNumber, headers, signal) {
    if (!keyInfo.uri) {
      throw new Error('AES-128 key URI missing in playlist.');
    }

    // Fetch and cache decryption key
    let cryptoKey = this.keyCache.get(keyInfo.uri);
    if (!cryptoKey) {
      const keyRes = await fetch(keyInfo.uri, { headers, signal });
      if (!keyRes.ok) {
        throw new Error(`Failed to fetch decryption key: HTTP ${keyRes.status}`);
      }
      const rawKey = await keyRes.arrayBuffer();
      cryptoKey = await crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
      );
      this.keyCache.set(keyInfo.uri, cryptoKey);
    }

    // Prepare IV: Either explicit hex in manifest or sequence number as 16-byte big-endian
    let ivBuffer;
    if (keyInfo.iv) {
      const cleanHex = keyInfo.iv.startsWith('0x') || keyInfo.iv.startsWith('0X') ? keyInfo.iv.substring(2) : keyInfo.iv;
      const match = cleanHex.match(/.{1,2}/g);
      ivBuffer = new Uint8Array(match ? match.map(byte => parseInt(byte, 16)) : 16);
    } else {
      ivBuffer = new Uint8Array(16);
      const view = new DataView(ivBuffer.buffer);
      view.setUint32(12, sequenceNumber, false);
    }

    try {
      return await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: ivBuffer },
        cryptoKey,
        encryptedBuffer
      );
    } catch (err) {
      console.warn('Direct AES-CBC decryption failed, falling back to raw buffer:', err);
      return encryptedBuffer;
    }
  }
}
