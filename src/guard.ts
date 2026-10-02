// Keeps one broken piece from freezing the whole game: a step that throws is skipped for this
// frame (and reported once), and everything else keeps running.

type Reporter = (where: string, err: unknown) => void;
let reporter: Reporter | null = null;
const reported = new Set<string>();

export function onGuardError(fn: Reporter) { reporter = fn; }

export function guard(where: string, fn: () => void) {
  try {
    fn();
  } catch (err) {
    if (reported.has(where)) return;
    reported.add(where);
    console.error(`[${where}]`, err);
    reporter?.(where, err);
  }
}
