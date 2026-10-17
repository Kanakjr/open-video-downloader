/**
 * Pure ES module HLS (m3u8) parser for master playlists and media segment playlists.
 */

export function isHlsPlaylist(content) {
  if (typeof content !== 'string') return false;
  return content.trim().startsWith('#EXTM3U');
}

export function isMasterPlaylist(content) {
  return content.includes('#EXT-X-STREAM-INF');
}

/**
 * Resolves a potentially relative URL against a base URL.
 */
export function resolveUrl(relativeOrAbsoluteUrl, baseUrl) {
  try {
    return new URL(relativeOrAbsoluteUrl, baseUrl).href;
  } catch {
    return relativeOrAbsoluteUrl;
  }
}

/**
 * Sanitizes and cleans page/video titles by removing branding suffixes and illegal filename characters.
 */
export function cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return 'Video';

  let title = raw.trim();

  // Strip common site suffixes and branding
  title = title.replace(/\s*[-–—|]\s*(YouTube|Vimeo|Twitch|Twitter|X|Facebook|Instagram|TikTok|Dailymotion|Bilibili|Rumble|Odysee|Kick)\s*$/i, '');
  title = title.replace(/\s*[-–—|]\s*(Watch Online|Full Movie|Free Streaming|HD Video|Official Video|Official Audio)\s*$/i, '');

  // Strip invalid filename characters for cross-platform compatibility (Windows/Mac/Linux)
  title = title.replace(/[<>:"/\\|?*]/g, '_');

  // Clean repeated spaces or underscores
  title = title.replace(/\s+/g, ' ').replace(/_+/g, '_').trim();

  // Limit max length to 120 chars
  if (title.length > 120) {
    title = title.substring(0, 120).trim();
  }

  return title || 'Video';
}

/**
 * Calculates estimated file size in bytes from bandwidth and duration.
 */
export function estimateHlsSize(bandwidth, totalDurationSeconds) {
  if (bandwidth && totalDurationSeconds && bandwidth > 0 && totalDurationSeconds > 0) {
    return Math.round((bandwidth / 8) * totalDurationSeconds);
  }
  return null;
}

/**
 * Parses a master playlist to extract all video and audio variants.
 */
export function parseMasterPlaylist(manifestText, manifestUrl) {
  const lines = manifestText.split(/\r?\n/);
  const variants = [];
  const audioTracks = [];
  const subtitles = [];
  let currentInfo = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = parseAttributes(line.substring('#EXT-X-MEDIA:'.length));
      const mediaType = (attributes.TYPE || '').toUpperCase();
      const name = (attributes.NAME || '').replace(/^["']|["']$/g, '');
      const language = (attributes.LANGUAGE || '').replace(/^["']|["']$/g, '');
      const uri = attributes.URI ? resolveUrl(attributes.URI.replace(/^["']|["']$/g, ''), manifestUrl) : null;
      const isDefault = attributes.DEFAULT === 'YES';

      if (mediaType === 'AUDIO' && uri) {
        audioTracks.push({
          type: 'audio',
          name: name || language || 'Audio',
          language,
          groupId: attributes['GROUP-ID'],
          uri,
          isDefault
        });
      } else if (mediaType === 'SUBTITLES' && uri) {
        subtitles.push({
          type: 'subtitles',
          name: name || language || 'Subtitle',
          language,
          groupId: attributes['GROUP-ID'],
          uri,
          isDefault
        });
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = parseAttributes(line.substring('#EXT-X-STREAM-INF:'.length));
      const bandwidth = parseInt(attributes['AVERAGE-BANDWIDTH'] || attributes.BANDWIDTH, 10) || 0;
      currentInfo = {
        bandwidth,
        averageBandwidth: parseInt(attributes['AVERAGE-BANDWIDTH'], 10) || null,
        resolution: attributes.RESOLUTION || null,
        codecs: attributes.CODECS || null,
        frameRate: attributes['FRAME-RATE'] ? parseFloat(attributes['FRAME-RATE']) : null,
        audioGroup: attributes.AUDIO || null,
        subtitlesGroup: attributes.SUBTITLES || null
      };

      if (currentInfo.resolution) {
        const [w, h] = currentInfo.resolution.split('x').map(n => parseInt(n, 10));
        currentInfo.width = w;
        currentInfo.height = h;
        currentInfo.qualityLabel = `${h}p`;
      } else {
        currentInfo.qualityLabel = currentInfo.bandwidth ? `${Math.round(currentInfo.bandwidth / 1000)} kbps` : 'Adaptive';
      }
    } else if (line.startsWith('#') && !line.startsWith('#EXT-X-STREAM-INF:')) {
      continue;
    } else if (currentInfo) {
      const streamUrl = resolveUrl(line, manifestUrl);
      variants.push({
        ...currentInfo,
        url: streamUrl
      });
      currentInfo = null;
    }
  }

  // Sort variants by bandwidth descending
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  variants.audioTracks = audioTracks;
  variants.subtitles = subtitles;
  return variants;
}

/**
 * Parses a media playlist into individual segments and encryption keys.
 */
export function parseMediaPlaylist(manifestText, playlistUrl) {
  const lines = manifestText.split(/\r?\n/);
  const segments = [];
  let totalDuration = 0;
  let targetDuration = 0;
  let mediaSequence = 0;
  let currentKey = null;
  let currentMap = null; // Initialization segment for fMP4
  let currentDuration = 0;
  let currentTitle = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-KEY:'.length));
      if (attrs.METHOD === 'NONE') {
        currentKey = null;
      } else {
        currentKey = {
          method: attrs.METHOD,
          uri: attrs.URI ? resolveUrl(attrs.URI.replace(/^["']|["']$/g, ''), playlistUrl) : null,
          iv: attrs.IV || null,
          keyFormat: attrs.KEYFORMAT || 'identity'
        };
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        currentMap = {
          uri: resolveUrl(attrs.URI.replace(/^["']|["']$/g, ''), playlistUrl),
          byterange: attrs.BYTERANGE || null
        };
      }
    } else if (line.startsWith('#EXTINF:')) {
      const commaIndex = line.indexOf(',');
      const durationStr = commaIndex !== -1 ? line.substring(8, commaIndex) : line.substring(8);
      currentDuration = parseFloat(durationStr) || 0;
      currentTitle = commaIndex !== -1 ? line.substring(commaIndex + 1).trim() : '';
    } else if (!line.startsWith('#')) {
      const segmentUrl = resolveUrl(line, playlistUrl);
      segments.push({
        index: segments.length,
        sequence: mediaSequence + segments.length,
        duration: currentDuration,
        title: currentTitle,
        url: segmentUrl,
        key: currentKey ? { ...currentKey } : null,
        initSegment: currentMap ? { ...currentMap } : null
      });
      totalDuration += currentDuration;
      currentDuration = 0;
      currentTitle = '';
    }
  }

  return {
    targetDuration,
    totalDuration,
    segmentCount: segments.length,
    segments,
    isEncrypted: segments.some(s => s.key && s.key.method !== 'NONE'),
    encryptionMethod: segments.find(s => s.key)?.key?.method || null,
    hasInitSegment: !!currentMap
  };
}

/**
 * Helper to parse comma-separated key=value or key="value" attributes from tags.
 */
function parseAttributes(attrString) {
  const result = {};
  const regex = /([A-Z0-9-]+)=(?:(?:"([^"]*)")|([^,]+))/gi;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    const key = match[1];
    const value = match[2] !== undefined ? match[2] : match[3];
    result[key] = value;
  }
  return result;
}
