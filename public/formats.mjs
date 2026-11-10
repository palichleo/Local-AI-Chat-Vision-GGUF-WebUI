/**
 * Picture formats and their resolutions: a short, clean list per format. Every size is a
 * multiple of 32 (the latent grid of the video models) and keeps its ratio within 1 %, except
 * MiniMax's own sizes (768 × 448, 1344 × 768), listed with 16:9 where they belong.
 */
const sizes = (...list) => list.map(([width, height]) => ({ width, height }));
const portrait = list => list.map(({ width, height }) => ({ width: height, height: width }));
const landscape = sizes([512, 288], [768, 448], [1024, 576], [1344, 768], [1600, 896], [1920, 1088]);
const classic = sizes([384, 288], [512, 384], [640, 480], [768, 576], [1024, 768], [1280, 960], [1536, 1152]);
const photo = sizes([384, 256], [576, 384], [768, 512], [960, 640], [1152, 768], [1344, 896], [1536, 1024]);

export const FORMATS = [
  { id: '16:9', label: '16:9 · Paysage', ratio: 16 / 9, sizes: landscape },
  { id: '9:16', label: '9:16 · Portrait', ratio: 9 / 16, sizes: portrait(landscape) },
  {
    id: '1:1',
    label: '1:1 · Carré',
    ratio: 1,
    sizes: sizes([384, 384], [512, 512], [768, 768], [1024, 1024], [1280, 1280], [1536, 1536]),
  },
  { id: '4:3', label: '4:3', ratio: 4 / 3, sizes: classic },
  { id: '3:4', label: '3:4', ratio: 3 / 4, sizes: portrait(classic) },
  { id: '3:2', label: '3:2', ratio: 3 / 2, sizes: photo },
  { id: '2:3', label: '2:3', ratio: 2 / 3, sizes: portrait(photo) },
  { id: '21:9', label: '21:9 · Cinéma', ratio: 21 / 9, sizes: sizes([672, 288], [896, 384], [1344, 576], [1792, 768]) },
];

const fits = (value, spec = {}) =>
  Number.isInteger(value) &&
  (spec.min === undefined || value >= spec.min) &&
  (spec.max === undefined || value <= spec.max) &&
  (!spec.multipleOf || value % spec.multipleOf === 0);

/** The format of a size (its ratio within 4 %), or null. */
export function formatOf(width, height) {
  if (!(width > 0 && height > 0)) return null;
  let best = null;
  for (const format of FORMATS) {
    const error = Math.abs(width / height / format.ratio - 1);
    if (error <= 0.04 && (!best || error < best.error)) best = { format, error };
  }
  return best?.format || null;
}

/** The sizes of a format the model accepts (`width`, `height`: its limits). */
export function sizesFor(format, { width, height } = {}) {
  return format.sizes.filter(size => fits(size.width, width) && fits(size.height, height));
}

/** The formats with at least one size the model accepts. */
export function formatsFor(limits) {
  return FORMATS.filter(format => sizesFor(format, limits).length);
}

/** In `list`, the size closest to `pixels` (on a ratio scale: 2× too big = 2× too small). */
export function nearestSize(list, pixels) {
  let best = null;
  for (const size of list) {
    const distance = Math.abs(Math.log((size.width * size.height) / pixels));
    if (!best || distance < best.distance) best = { size, distance };
  }
  return best?.size || null;
}
