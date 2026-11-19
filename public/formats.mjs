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

/**
 * The sizes of a family of models that has lists of its own (0.6.92): Krea 2, a model of images,
 * whose pictures may be larger than the clips of the video models. Each of its lists leaves out the
 * two smallest sizes of the common one and goes two sizes further, by the step that list takes
 * (16:9: 1920 × 1088, then 2240 × 1248 and 2560 × 1440). On the card of 12 GB, Krea 2 was measured
 * up to 1536 × 1536 and 1920 × 1088 (runner/MEMORY-STUDY.md); the two larger sizes were tried by the
 * user on 18 November 2026: 30 s then 53 s a picture.
 */
const further = {
  '16:9': sizes([2240, 1248], [2560, 1440]),
  '1:1': sizes([1792, 1792], [2048, 2048]),
  '4:3': sizes([1792, 1344], [2048, 1536]),
  '3:2': sizes([1728, 1152], [1920, 1280]),
  '21:9': sizes([2240, 960], [2688, 1152]),
};
const TURNED = { '9:16': '16:9', '3:4': '4:3', '2:3': '3:2' };
export const FAMILY_SIZES = {
  krea2: Object.fromEntries(
    FORMATS.map(format => [
      format.id,
      [...format.sizes.slice(2), ...(further[format.id] ?? portrait(further[TURNED[format.id]]))],
    ]),
  ),
};

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

/**
 * The format of a size, and for a ratio none is close to (16:10, a panorama) the nearest of them
 * (0.6.92): the Studio shows the size a take was made at whatever its ratio.
 */
export function nearestFormat(width, height) {
  if (!(width > 0 && height > 0)) return null;
  const distance = format => Math.abs(Math.log(width / height / format.ratio));
  return formatOf(width, height) ?? FORMATS.reduce((best, item) => (distance(item) < distance(best) ? item : best));
}

/** Whether the model accepts a size (`width`, `height`: its limits). */
export function sizeFits(size, { width, height } = {}) {
  return fits(size?.width, width) && fits(size?.height, height);
}

/**
 * The sizes of a format the model accepts (`width`, `height`: its limits), from the lists of its
 * family when it has its own (`family`: its pipeline, « krea2 »).
 */
export function sizesFor(format, limits = {}, family = null) {
  const list = Object.hasOwn(FAMILY_SIZES, family ?? '') ? FAMILY_SIZES[family][format.id] : format.sizes;
  return (list ?? format.sizes).filter(size => sizeFits(size, limits));
}

/** The formats with at least one size the model accepts. */
export function formatsFor(limits, family = null) {
  return FORMATS.filter(format => sizesFor(format, limits, family).length);
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
