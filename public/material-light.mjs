// One pending frame at most; nothing runs while the pointer is idle.
export function setupMaterialLighting(surfaces, host = window) {
  const media = host.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)');
  let frame = null, pending = null, active = null;
  function reset() {
    if (frame !== null) host.cancelAnimationFrame(frame);
    frame = null; pending = null;
    active?.removeAttribute('data-material-lit'); active = null;
  }
  function paint() {
    frame = null;
    if (!pending || !media.matches || host.document.hidden) { reset(); return; }
    const { surface, x, y } = pending;
    pending = null;
    const rect = surface.getBoundingClientRect();
    surface.style.setProperty('--light-x', `${Math.round(x - rect.left)}px`);
    surface.style.setProperty('--light-y', `${Math.round(y - rect.top)}px`);
    active = surface;
    surface.setAttribute('data-material-lit', '');
  }
  const removers = [];
  for (const surface of surfaces) {
    const move = event => {
      if (!media.matches || host.document.hidden || event.pointerType === 'touch') return;
      if (active && active !== surface) active.removeAttribute('data-material-lit');
      pending = { surface, x: event.clientX, y: event.clientY };
      if (frame === null) frame = host.requestAnimationFrame(paint);
    };
    surface.addEventListener('pointermove', move, { passive: true });
    surface.addEventListener('pointerleave', reset);
    surface.addEventListener('pointercancel', reset);
    removers.push(() => {
      surface.removeEventListener('pointermove', move);
      surface.removeEventListener('pointerleave', reset);
      surface.removeEventListener('pointercancel', reset);
    });
  }
  media.addEventListener('change', reset);
  host.addEventListener('blur', reset);
  host.document.addEventListener('visibilitychange', reset);
  function dispose() {
    reset(); removers.forEach(remove => remove());
    media.removeEventListener('change', reset);
    host.removeEventListener('blur', reset);
    host.document.removeEventListener('visibilitychange', reset);
    host.removeEventListener('pagehide', dispose);
  }
  host.addEventListener('pagehide', dispose);
  return dispose;
}
