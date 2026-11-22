// ============================================================
//  Network helpers shared by translate.js, furigana.js and romanize.js.
// ============================================================

/**
 * An AbortSignal that aborts after `ms`: a fetch given it gives up on a
 * stalled connection instead of waiting forever (a phone changing networks
 * can leave one open with nothing coming).  AbortSignal.timeout where the
 * browser has it; a timer on older ones (iOS before 16).
 */
export function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`timed out after ${ms} ms`)), ms);
  return controller.signal;
}
