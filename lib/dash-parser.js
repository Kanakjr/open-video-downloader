/**
 * Pure ES module parser for DASH MPD (Media Presentation Description) manifests.
 */

import { resolveUrl } from './hls-parser.js';

export function isDashManifest(content) {
  if (typeof content !== 'string') return false;
  return content.includes('<MPD') || content.includes('urn:mpeg:dash:schema:mpd');
}

/**
 * Parses a DASH MPD XML manifest string into video and audio representations.
 */
export function parseDashManifest(xmlText, manifestUrl) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'application/xml');

  if (xml.querySelector('parsererror')) {
    throw new Error('Failed to parse DASH MPD XML manifest.');
  }

  const mpd = xml.querySelector('MPD');
  if (!mpd) {
    throw new Error('No <MPD> root element found in DASH manifest.');
  }

  const mediaPresentationDuration = parseDuration(mpd.getAttribute('mediaPresentationDuration'));
  const periods = xml.querySelectorAll('Period');

  const videoStreams = [];
  const audioStreams = [];

  periods.forEach((period, periodIdx) => {
    const adaptationSets = period.querySelectorAll('AdaptationSet');

    adaptationSets.forEach((adSet) => {
      const mimeType = adSet.getAttribute('mimeType') || '';
      const contentType = adSet.getAttribute('contentType') || (mimeType.startsWith('video') ? 'video' : mimeType.startsWith('audio') ? 'audio' : '');

      const representations = adSet.querySelectorAll('Representation');
      representations.forEach((rep) => {
        const id = rep.getAttribute('id') || `p${periodIdx}-rep`;
        const bandwidth = parseInt(rep.getAttribute('bandwidth'), 10) || 0;
        const width = parseInt(rep.getAttribute('width') || adSet.getAttribute('width'), 10) || null;
        const height = parseInt(rep.getAttribute('height') || adSet.getAttribute('height'), 10) || null;
        const codecs = rep.getAttribute('codecs') || adSet.getAttribute('codecs') || null;
        const repMime = rep.getAttribute('mimeType') || mimeType;

        const isVideo = contentType === 'video' || repMime.startsWith('video') || (width && height);

        // Check for BaseURL
        let streamUrl = manifestUrl;
        const baseUrlEl = rep.querySelector('BaseURL') || adSet.querySelector('BaseURL') || period.querySelector('BaseURL');
        if (baseUrlEl) {
          streamUrl = resolveUrl(baseUrlEl.textContent.trim(), manifestUrl);
        }

        const streamInfo = {
          id,
          bandwidth,
          width,
          height,
          codecs,
          mimeType: repMime,
          url: streamUrl,
          duration: mediaPresentationDuration,
          qualityLabel: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : 'Audio/Video'
        };

        if (isVideo) {
          videoStreams.push(streamInfo);
        } else {
          audioStreams.push(streamInfo);
        }
      });
    });
  });

  videoStreams.sort((a, b) => b.bandwidth - a.bandwidth);
  audioStreams.sort((a, b) => b.bandwidth - a.bandwidth);

  return {
    duration: mediaPresentationDuration,
    videoStreams,
    audioStreams
  };
}

/**
 * Parses ISO 8601 duration strings like PT1H2M30.5S into seconds.
 */
function parseDuration(str) {
  if (!str) return null;
  const match = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!match) return null;
  const hours = parseFloat(match[1] || 0);
  const minutes = parseFloat(match[2] || 0);
  const seconds = parseFloat(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}
