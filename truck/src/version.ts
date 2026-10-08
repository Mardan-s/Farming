// Build identity and a self-update check. Phones like to keep an old copy of the page (from the
// HTTP cache or a tab restored from memory), so the game asks the server for the current page and
// reloads itself when a newer build is out.

declare const __BUILD__: string;

/** Build timestamp; the page also carries it as <meta name="eh-build" content="eh-build-…">. */
export const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
export const VERSION = 'v8';

/** Short label for the title screen: version and build date. */
export function versionLabel() {
  const t = Number(BUILD);
  if (!t) return `${VERSION} · dev`;
  const d = new Date(t);
  return `${VERSION} · ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Resolves to the URL of a newer build if one is online, otherwise null. */
export async function newerBuild(): Promise<string | null> {
  if (!/github\.io$/.test(location.hostname) || BUILD === 'dev') return null;
  try {
    const r = await fetch(`${location.pathname}?check=${Date.now()}`, { cache: 'no-store' });
    const m = (await r.text()).match(/eh-build-(\d+)/);
    if (!m || m[1] === BUILD || Number(m[1]) < Number(BUILD)) return null;
    const url = new URL(location.href);
    // Already tried loading this build once: don't loop if a cache still serves the old page.
    if (url.searchParams.get('v') === m[1]) return null;
    url.searchParams.set('v', m[1]);
    return url.toString();
  } catch {
    return null;
  }
}
