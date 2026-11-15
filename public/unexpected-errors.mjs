/**
 * An error nobody caught stops what the user asked for: said in a notice, discreetly, instead of a
 * button that does nothing (« Nouveau chat » stopped silently from 0.5.87 to 0.5.109). Not said:
 * a request given up on purpose (AbortError), the browser's own ResizeObserver note, an error of
 * another origin (an extension), or the same one again within 10 s. Written to the console too.
 */
const QUIET = /AbortError|ResizeObserver loop|The user aborted|The operation was aborted/i;

export function unexpectedMessage(error) {
  const message = String(error?.message ?? error ?? '').trim();
  if (!message || QUIET.test(String(error?.name ?? '')) || QUIET.test(message)) return '';
  return 'Une action s’est arrêtée sur une erreur inattendue : ' + message;
}

export function setupUnexpectedErrors({ view = globalThis, notice, quiet = () => false, log = console.error, now = Date.now }) {
  let last = '',
    lastAt = 0;
  function tell(error) {
    const said = unexpectedMessage(error);
    // Leaving the page, updating or closing: what fails then is not the user's action.
    if (!said || quiet()) return;
    if (said === last && now() - lastAt < 10000) return;
    last = said;
    lastAt = now();
    log(error);
    notice(said);
  }
  view.addEventListener?.('error', event => {
    // This page's scripts only.
    if (event.filename && view.location && !event.filename.startsWith(view.location.origin)) return;
    tell(event.error ?? event.message);
  });
  view.addEventListener?.('unhandledrejection', event => tell(event.reason));
  return { tell };
}
