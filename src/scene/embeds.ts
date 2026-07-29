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

/** Overlay hosts, framed exactly as given — they are already embed endpoints. */
const OVERLAY_HOSTS: [string, EmbedProvider][] = [
  ['streamelements.com', 'streamelements'],
  ['streamlabs.com', 'streamlabs'],
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

  const twitch = twitchChannel(host, url);
  if (twitch) return { provider: 'twitch', url: `https://www.twitch.tv/${twitch}` };

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
  if (item.provider === 'youtube') {
    const id = new URL(item.url).searchParams.get('v') ?? '';
    // nocookie: the overlay has no need to write tracking cookies into a
    // broadcast machine's browser profile.
    const src = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
    src.searchParams.set('autoplay', '1');
    src.searchParams.set('mute', '1');
    src.searchParams.set('playsinline', '1');
    src.searchParams.set('rel', '0');
    return src.toString();
  }

  if (item.provider === 'twitch') {
    const channel = new URL(item.url).pathname.slice(1);
    const src = new URL('https://player.twitch.tv/');
    src.searchParams.set('channel', channel);
    src.searchParams.set('parent', location.hostname);
    src.searchParams.set('muted', 'true');
    src.searchParams.set('autoplay', 'true');
    return src.toString();
  }

  return item.url;
}
