import type { EmbedItem, EmbedProvider } from './sceneTypes';

/**
 * What may be framed, and what URL actually gets framed.
 *
 * An allowlist, never a blocklist. A scene arrives from a URL someone else
 * built, so "any https page" would make a shared link a way to run a chosen
 * page inside the operator's broadcast. Every entry here is a host that exists
 * to be embedded.
 *
 * Two layers, and this is only the first: `frame-src` in `public/_headers` is
 * the second, and unlike this one it cannot be edited away in devtools.
 */

interface Match {
  provider: EmbedProvider;
  /** Normalised, environment-independent. Never contains `parent` or autoplay. */
  url: string;
}

/**
 * Hosts framed exactly as given — they are already embed endpoints.
 *
 * The Korean services are here because they are what this audience actually
 * runs: 투네이션 and 트윕 are the donation-alert widgets, 치지직 is Naver's
 * streaming platform. A lineup of only Twitch and Streamlabs would be a lineup
 * for somebody else's streamers.
 */
const OVERLAY_HOSTS: [string, EmbedProvider][] = [
  ['streamelements.com', 'streamelements'],
  ['streamlabs.com', 'streamlabs'],
  ['toon.at', 'toonation'],
  ['twip.kr', 'twip'],
  ['ko-fi.com', 'kofi'],
  ['chzzk.naver.com', 'chzzk'],
  ['soundcloud.com', 'soundcloud'],
  ['open.spotify.com', 'spotify'],
  ['player.kick.com', 'kick'],
];

export function sanitizeEmbedUrl(raw: unknown): Match | null {
  if (typeof raw !== 'string' || raw.length > 600) return null;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  // https only. An http frame is blocked as mixed content anyway, and the
  // failure would look like "the embed is broken" rather than "it is insecure".
  if (url.protocol !== 'https:') return null;

  // Never frame ourselves. `allow-scripts` plus `allow-same-origin` on a
  // same-origin frame lets the page remove its own sandbox; keeping our origin
  // out of the allowlist is what makes that combination safe below.
  if (url.hostname === location.hostname) return null;

  const host = url.hostname.replace(/^www\./, '');

  for (const [suffix, provider] of OVERLAY_HOSTS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return { provider, url: url.toString() };
    }
  }

  const youtube = youtubeId(host, url);
  if (youtube) return { provider: 'youtube', url: `https://www.youtube.com/watch?v=${youtube}` };

  // Chat before player: /embed/<channel>/chat is also under twitch.tv.
  if ((host === 'twitch.tv' || host === 'player.twitch.tv') && /\/chat\/?$/.test(url.pathname)) {
    const channel = url.pathname.split('/').filter(Boolean).slice(-2)[0];
    if (channel && /^[A-Za-z0-9_]{3,26}$/.test(channel)) {
      return { provider: 'twitch-chat', url: `https://www.twitch.tv/embed/${channel}/chat` };
    }
  }

  const twitch = twitchChannel(host, url);
  if (twitch) return { provider: 'twitch', url: `https://www.twitch.tv/${twitch}` };

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = /(\d{6,12})/.exec(url.pathname);
    if (id) return { provider: 'vimeo', url: `https://vimeo.com/${id[1]!}` };
  }

  if (host === 'kick.com') {
    const channel = url.pathname.slice(1).split('/')[0];
    if (channel && /^[A-Za-z0-9_-]{3,26}$/.test(channel)) {
      return { provider: 'kick', url: `https://player.kick.com/${channel}` };
    }
  }

  return null;
}

function youtubeId(host: string, url: URL): string | null {
  const clean = (value: string | null) =>
    value && /^[A-Za-z0-9_-]{6,20}$/.test(value) ? value : null;

  if (host === 'youtu.be') return clean(url.pathname.slice(1));
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') return clean(url.searchParams.get('v'));
    const embed = /^\/embed\/([^/]+)$/.exec(url.pathname);
    if (embed) return clean(embed[1]!);
    const live = /^\/live\/([^/]+)$/.exec(url.pathname);
    if (live) return clean(live[1]!);
  }
  return null;
}

function twitchChannel(host: string, url: URL): string | null {
  if (host !== 'twitch.tv' && host !== 'player.twitch.tv') return null;
  const fromQuery = url.searchParams.get('channel');
  const candidate = fromQuery ?? url.pathname.slice(1).split('/')[0];
  return candidate && /^[A-Za-z0-9_]{3,26}$/.test(candidate) ? candidate : null;
}

/**
 * The URL actually given to the iframe, built fresh every render.
 *
 * `parent` is the reason this is a function and not a stored field. Twitch
 * rejects any embed whose `parent` does not match the page's own hostname, so
 * baking it in at authoring time produces a scene that works for its author and
 * shows a permission error for everyone else — the exact failure a shareable
 * scene link must not have.
 *
 * Muted autoplay throughout: an overlay never receives a click (the scene layer
 * is input-transparent, and OBS cannot click anyway), and browsers refuse
 * unmuted autoplay regardless. Broadcast audio comes from the desktop.
 */
export function embedSrc(item: EmbedItem): string {
  const muted = item.muted !== false;

  if (item.provider === 'youtube') {
    const id = new URL(item.url).searchParams.get('v') ?? '';
    // nocookie: the overlay has no need to write tracking cookies into a
    // broadcast machine's browser profile.
    const src = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
    src.searchParams.set('autoplay', '1');
    src.searchParams.set('mute', muted ? '1' : '0');
    src.searchParams.set('playsinline', '1');
    src.searchParams.set('rel', '0');
    return src.toString();
  }

  if (item.provider === 'twitch') {
    const channel = new URL(item.url).pathname.slice(1);
    const src = new URL('https://player.twitch.tv/');
    src.searchParams.set('channel', channel);
    src.searchParams.set('parent', location.hostname);
    src.searchParams.set('muted', muted ? 'true' : 'false');
    src.searchParams.set('autoplay', 'true');
    return src.toString();
  }

  if (item.provider === 'twitch-chat') {
    // `/embed/<channel>/chat` — the channel is second from the end, not last.
    const parts = new URL(item.url).pathname.split('/').filter(Boolean);
    const channel = parts[parts.length - 2] ?? '';
    const src = new URL(`https://www.twitch.tv/embed/${channel}/chat`);
    src.searchParams.set('parent', location.hostname);
    src.searchParams.set('darkpopout', '');
    return src.toString();
  }

  // These two refuse to be framed at their page URL — each has a separate
  // player endpoint, and pointing at the page produces a blank box.
  if (item.provider === 'soundcloud') {
    const src = new URL('https://w.soundcloud.com/player/');
    src.searchParams.set('url', item.url);
    src.searchParams.set('auto_play', muted ? 'false' : 'true');
    return src.toString();
  }

  if (item.provider === 'spotify') {
    const path = new URL(item.url).pathname.replace(/^\/embed/, '');
    return `https://open.spotify.com/embed${path}`;
  }

  if (item.provider === 'vimeo') {
    const id = new URL(item.url).pathname.slice(1);
    const src = new URL(`https://player.vimeo.com/video/${id}`);
    src.searchParams.set('autoplay', '1');
    src.searchParams.set('muted', muted ? '1' : '0');
    return src.toString();
  }

  return item.url;
}
