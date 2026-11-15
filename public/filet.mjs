/**
 * The filet of the window (moodix-design.md 7 bis 20): 1.5 px on its inner edge. Along the top, one
 * continuous gradient from the middle of the left corner to the middle of the right one, each colour
 * pure only at the middle of its old segment (STOPS, the gradient of the foot of Générer); past the
 * corners it slides down the sides (blue to green on the left, red to yellow on the right) and
 * fades out over 620 px. No line at the bottom. Drawn for the window's real size (the svg lies
 * exactly over the window, border included).
 */
const NS = 'http://www.w3.org/2000/svg';
const BLUE = '#3d6bf5',
  GREEN = '#22a060',
  YELLOW = '#f6c343',
  RED = '#e8402f';
/**
 * Each colour pure at the middle of its segment of the logo's rule (4 / 2 / 3 / 1.5): the same
 * gradient as --mdx-gradient in moodix.css.
 */
export const STOPS = [
  [0.19, BLUE],
  [0.476, GREEN],
  [0.714, YELLOW],
  [0.929, RED],
];
let drawn = 0;

function element(name, attributes = {}, children = []) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}
const stop = (offset, color, opacity = 1) =>
  element('stop', { offset, 'stop-color': color, 'stop-opacity': opacity });

/** Draws the filet in `svg` for a window of `width` × `height` px (corners of `radius` px). */
export function drawFilet(svg, width, height, { radius = 16, stroke = 1.5, fade = 620 } = {}) {
  if (!(width > 2 * radius) || !(height > 2 * radius)) {
    svg.replaceChildren();
    return svg;
  }
  const id = 'mdx-filet-' + ++drawn,
    inset = stroke / 2,
    round = radius - inset,
    // The middle of the arc of each top corner: the top ends there, the sides begin there.
    corner = +(radius - round * Math.SQRT1_2).toFixed(2),
    // Gone 620 px down the sides; before the bottom corners on a lower window.
    end = Math.min(fade, height - radius),
    arc = `A ${round} ${round} 0 0`;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  const along = element(
    'linearGradient',
    { id: id + '-top', gradientUnits: 'userSpaceOnUse', x1: corner, y1: 0, x2: width - corner, y2: 0 },
    STOPS.map(([offset, color]) => stop(offset, color)),
  );
  const side = (name, top, bottom) =>
    element('linearGradient', { id: id + '-' + name, gradientUnits: 'userSpaceOnUse', x1: 0, y1: corner, x2: 0, y2: end }, [
      stop(0, top),
      stop(0.45, bottom, 0.75),
      stop(1, bottom, 0),
    ]);
  const line = (d, paint) =>
    element('path', { d, fill: 'none', stroke: `url(#${id}-${paint})`, 'stroke-width': stroke, 'stroke-linecap': 'butt' });
  svg.replaceChildren(
    element('defs', {}, [along, side('left', BLUE, GREEN), side('right', RED, YELLOW)]),
    line(`M ${corner} ${corner} ${arc} 1 ${radius} ${inset} H ${width - radius} ${arc} 1 ${width - corner} ${corner}`, 'top'),
    line(`M ${corner} ${corner} ${arc} 0 ${inset} ${radius} V ${end}`, 'left'),
    line(`M ${width - corner} ${corner} ${arc} 1 ${width - inset} ${radius} V ${end}`, 'right'),
  );
  return svg;
}

/**
 * Lays the filet exactly over `window` (border included) and draws it again at each change of its
 * size or place: the window resized, the sidebar folded.
 */
export function followWindow(svg, window, view = globalThis) {
  if (!svg || !window) return () => {};
  const place = () => {
    const box = window.getBoundingClientRect();
    Object.assign(svg.style, {
      left: box.left + 'px',
      top: box.top + 'px',
      width: box.width + 'px',
      height: box.height + 'px',
    });
    drawFilet(svg, Math.round(box.width), Math.round(box.height));
  };
  place();
  if (typeof view.ResizeObserver === 'function') new view.ResizeObserver(place).observe(window);
  view.addEventListener?.('resize', place);
  return place;
}
