/**
 * The filet of the window: the four colours of the logo along its top, blue, green, yellow and
 * red in one continuous gradient; past the two corners it slides down the sides (blue to green on
 * the left, red to yellow on the right) and fades out towards half the height. No line at the
 * bottom. Drawn for the window's real size, on its border (the svg lies exactly over the window,
 * border included).
 */
const NS = 'http://www.w3.org/2000/svg';
const BLUE = '#3d6bf5',
  GREEN = '#22a060',
  YELLOW = '#f6c343',
  RED = '#e8402f';
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
export function drawFilet(svg, width, height, { radius = 16, stroke = 2 } = {}) {
  if (!(width > 2 * radius) || !(height > 2 * radius)) return svg.replaceChildren();
  const id = 'mdx-filet-' + ++drawn,
    inset = stroke / 2,
    round = radius - inset,
    middle = Math.round(height / 2);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  const along = element(
    'linearGradient',
    { id: id + '-top', gradientUnits: 'userSpaceOnUse', x1: radius, y1: 0, x2: width - radius, y2: 0 },
    [stop(0, BLUE), stop(0.36, GREEN), stop(0.68, YELLOW), stop(1, RED)],
  );
  const side = (name, top, bottom) =>
    element('linearGradient', { id: id + '-' + name, gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 0, y2: middle }, [
      stop(0, top),
      stop(0.45, bottom, 0.75),
      stop(1, bottom, 0),
    ]);
  const line = (d, paint) =>
    element('path', { d, fill: 'none', stroke: `url(#${id}-${paint})`, 'stroke-width': stroke, 'stroke-linecap': 'butt' });
  svg.replaceChildren(
    element('defs', {}, [along, side('left', BLUE, GREEN), side('right', RED, YELLOW)]),
    line(`M ${radius} ${inset} H ${width - radius}`, 'top'),
    line(`M ${radius} ${inset} A ${round} ${round} 0 0 0 ${inset} ${radius} V ${middle}`, 'left'),
    line(`M ${width - radius} ${inset} A ${round} ${round} 0 0 1 ${width - inset} ${radius} V ${middle}`, 'right'),
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
