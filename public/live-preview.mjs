/**
 * What the generator has so far, shown in the frame of a creation in progress: the picture goes
 * under the moving background (which `has-preview` dims for it). No grain over it: the grain is
 * of the interface, never of a picture. The same in a conversation and in the Studio.
 */
export function livePreview(node, frame) {
  const picture = node('img', 'live-preview');
  picture.alt = '';
  picture.decoding = 'async';
  picture.setAttribute('aria-hidden', 'true');
  let wanted = '';
  // Shown once the first picture is there; the browser keeps a picture until the next has loaded.
  picture.onload = () => frame.classList.add('has-preview');
  return {
    /** The address of the picture so far; the same address twice changes nothing. */
    show(url) {
      if (!url || url === wanted) return;
      wanted = url;
      if (picture.parentNode !== frame) frame.prepend(picture);
      picture.src = url;
    },
    /** The creation is there, or the generation stopped: the frame is as before. */
    clear() {
      wanted = '';
      // Nothing was shown: nothing to take away.
      if (picture.parentNode !== frame) return;
      frame.classList.remove('has-preview');
      picture.remove();
    },
  };
}
