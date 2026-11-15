/**
 * « #ref3 » in the message box: written where the cursor is when a file joins the message (it is
 * kept as a reference of the project), taken out with its attachment. The model, and the check
 * that a named image reaches the generator (lib/cited-resources.mjs), read it as such.
 */

/** `text` with `label` written between `start` and `end` (the selection), spaced; the caret after. */
export function withReference(text, label, start = text.length, end = start) {
  const before = text.slice(0, start),
    after = text.slice(end),
    written = (before && !/\s$/.test(before) ? ' ' : '') + label + (/^\s/.test(after) ? '' : ' ');
  return { text: before + written + after, caret: before.length + written.length };
}

/** `text` without `label` (« #ref3 », never « #ref31 »), and without the space it brought. */
export function withoutReference(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(^|\\s)${escaped}(?!\\d)( ?)`), (match, space, after) =>
    space && after ? space : space || '',
  );
}
