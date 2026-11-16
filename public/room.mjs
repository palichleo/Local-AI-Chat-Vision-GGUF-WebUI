/**
 * La salle (« Salle obscure », 0.6.0) : ce qui est derrière la page. Un fond très sombre, la lumière
 * de la dernière prise, des halos, le grain et un tramage (claude_design/maquettes,
 * direction-artistique.md). Ce module donne la texture de chaque grain et prépare la lumière d'une
 * prise ; les couleurs de chaque salle sont dans moodix.css (partie 4).
 *
 * Les dégradés sombres ne doivent pas sauter par bandes : la lumière est faite une fois par prise,
 * en deux images opaques de 128 px (un voile en multiply, une lumière en screen), agrandies sans
 * flou en direct ; un tramage de bruit bleu passe sur tout l'écran.
 */

export const ROOMS = ['salle', 'ecran', 'nuit', 'velours', 'tirage', 'lavande'];
export const LIGHTS = ['plusieurs', 'une', 'discret'];
export const GRAINS = ['aucun', 'poudre', 'fin', 'film', 'gros'];
export const FILTERS = ['diffusion', 'lumiere', 'centre'];
/** Le réglage de l'application et de toutes les maquettes. */
export const DEFAULTS = Object.freeze({
  room: 'salle',
  light: 'plusieurs',
  grain: 'poudre',
  dose: 40,
  motion: '24',
  filters: Object.freeze(['diffusion', 'lumiere']),
});
// Le bruit fractal de chaque grain : fréquence × octaves.
const NOISE = { poudre: [1.25, 1], fin: [0.9, 2], film: [0.62, 3], gros: [0.4, 3] };
// La force de la lumière de la prise et le vignettage, selon l'éclairage.
const STRENGTH = { plusieurs: [1, 0.55], une: [0.7, 0.32], discret: [0.4, 0.18] };

/** Un réglage complet et valide, à partir de ce qui a été enregistré (le reste par défaut). */
export function roomSettings(saved = {}) {
  const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);
  const dose = Number(saved.dose);
  return {
    room: pick(saved.room, ROOMS, DEFAULTS.room),
    light: pick(saved.light, LIGHTS, DEFAULTS.light),
    grain: pick(saved.grain, GRAINS, DEFAULTS.grain),
    dose: Number.isFinite(dose) ? Math.min(100, Math.max(0, Math.round(dose / 5) * 5)) : DEFAULTS.dose,
    motion: saved.motion === 'fige' ? 'fige' : '24',
    filters: Array.isArray(saved.filters) ? FILTERS.filter(name => saved.filters.includes(name)) : [...DEFAULTS.filters],
  };
}

/**
 * La tuile d'un grain (256 px, répétable), en CSS. Avec le filtre Lumière, un bruit gris posé en
 * overlay ; sans, des points clairs. La Diffusion est cuite dans la tuile (un flou de 0,6 px fait
 * une fois), jamais un flou en direct sur le calque.
 */
export function grainImage(grain, filters = DEFAULTS.filters) {
  const [frequency, octaves] = NOISE[grain] ?? NOISE.poudre;
  const tone = filters.includes('lumiere')
    ? "<feColorMatrix type='saturate' values='0'/><feComponentTransfer><feFuncA type='table' tableValues='1 1'/></feComponentTransfer>"
    : "<feColorMatrix type='matrix' values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 2.4 0 0 0 -1.45'/>";
  const soft = filters.includes('diffusion') ? "<feGaussianBlur stdDeviation='0.6'/>" : '';
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'>" +
    "<filter id='g' x='0' y='0' width='100%' height='100%' color-interpolation-filters='sRGB'>" +
    `<feTurbulence type='fractalNoise' baseFrequency='${frequency}' numOctaves='${octaves}' stitchTiles='stitch'/>` +
    tone +
    soft +
    "</filter><rect width='256' height='256' filter='url(#g)'/></svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Ce que le CSS de la salle lit d'un réglage : attributs de la racine et variables. */
export function roomStyle(settings) {
  const value = roomSettings(settings),
    lumiere = value.filters.includes('lumiere'),
    [strength, vignette] = STRENGTH[value.light];
  return {
    data: { room: value.room, light: value.light, grain: value.grain, motion: value.motion, filters: value.filters.join(' ') },
    variables: {
      '--grain-image': value.grain === 'aucun' ? 'none' : grainImage(value.grain, value.filters),
      // Opacité = base × dose : 0,5 pour le bruit gris en overlay, 0,15 pour les points clairs.
      '--grain-opacity': String(((lumiere ? 0.5 : 0.15) * value.dose) / 100),
      '--grain-blend': lumiere ? 'overlay' : 'normal',
      '--light-strength': String(strength),
      '--vignette': String(vignette),
    },
  };
}

/** Pose un réglage sur la page (en direct : rien d'autre à recalculer). */
export function applyRoom(settings, root = document.documentElement) {
  const { data, variables } = roomStyle(settings);
  Object.assign(root.dataset, data);
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
}

// --------------------------------------------------------------- la lumière de la dernière prise

const SIDE = 128;
// La lumière à l'écran d'une prise de 1 280 px floutée de 110 px : 11 px sur 128.
const SIGMA = 11;
const SATURATION = 1.35;
// Sa force la plus grande (au centre, éclairage « plusieurs sources ») : une lueur, pas une image.
const FORCE = 0.24;

function blurred(channel) {
  const radius = Math.ceil(SIGMA * 3),
    weights = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let k = -radius; k <= radius; k++) total += weights[k + radius] = Math.exp(-(k * k) / (2 * SIGMA * SIGMA));
  for (let k = 0; k < weights.length; k++) weights[k] /= total;
  const pass = (source, horizontal) => {
    const out = new Float32Array(SIDE * SIDE);
    for (let y = 0; y < SIDE; y++)
      for (let x = 0; x < SIDE; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = horizontal ? Math.min(SIDE - 1, Math.max(0, x + k)) : x,
            sy = horizontal ? y : Math.min(SIDE - 1, Math.max(0, y + k));
          sum += source[sy * SIDE + sx] * weights[k + radius];
        }
        out[y * SIDE + x] = sum;
      }
    return out;
  };
  return pass(pass(channel, true), false);
}

/**
 * Les deux images de la lumière d'une prise (elle est chargée, de la même origine) : réduite,
 * floutée en calcul flottant, saturée, sous un disque doux. `veil` (blanc = rien) se pose en
 * multiply, `glow` (noir = rien) en screen : ensemble, la prise se fond dans le fond sans bord.
 */
export function lightImages(image, doc = document) {
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = SIDE;
  const context = canvas.getContext('2d', { willReadFrequently: true }),
    width = image.naturalWidth || image.videoWidth || SIDE,
    height = image.naturalHeight || image.videoHeight || SIDE,
    scale = Math.max(SIDE / width, SIDE / height);
  context.drawImage(image, (SIDE - width * scale) / 2, (SIDE - height * scale) / 2, width * scale, height * scale);
  const { data } = context.getImageData(0, 0, SIDE, SIDE),
    channels = [0, 1, 2].map(offset => {
      const values = new Float32Array(SIDE * SIDE);
      for (let index = 0; index < values.length; index++) values[index] = data[index * 4 + offset] / 255;
      return blurred(values);
    });
  const veil = context.createImageData(SIDE, SIDE),
    glow = context.createImageData(SIDE, SIDE);
  for (let y = 0; y < SIDE; y++)
    for (let x = 0; x < SIDE; x++) {
      const index = y * SIDE + x,
        distance = Math.hypot((x + 0.5) / SIDE - 0.5, (y + 0.5) / SIDE - 0.5) / 0.5,
        // Un disque doux (courbe en cosinus) : rien au bord, l'image agrandie n'a pas de bord.
        alpha = (distance >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * distance))) * FORCE,
        [r, g, b] = channels.map(channel => channel[index]),
        luma = 0.2126 * r + 0.7152 * g + 0.0722 * b,
        tint = [r, g, b].map(value => Math.min(1, Math.max(0, luma + (value - luma) * SATURATION)));
      const shade = Math.round(255 * (1 - alpha));
      veil.data.set([shade, shade, shade, 255], index * 4);
      glow.data.set([...tint.map(value => Math.round(255 * value * alpha)), 255], index * 4);
    }
  const draw = pixels => {
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL('image/png');
  };
  return { veil: draw(veil), glow: draw(glow) };
}

const LIGHT = 'moodix.lumiere';
let shown = null;

function show(light, root) {
  const veil = root.querySelector?.('.room-veil'),
    glow = root.querySelector?.('.room-glow');
  if (!veil || !glow) return;
  veil.src = light?.veil || '';
  glow.src = light?.glow || '';
  veil.hidden = glow.hidden = !light;
}

/**
 * La lumière de la dernière prise (image, ou vidéo par sa vignette), faite une seule fois par
 * prise et gardée dans le navigateur ; rien quand il n'y a pas encore de prise. Rend l'identifiant
 * de la prise la plus récente, quelle qu'elle soit (un son aussi) : null s'il n'y en a pas,
 * undefined si la Pellicule n'a pas répondu.
 */
export async function refreshLight(api, { root = document, storage = globalThis.localStorage } = {}) {
  let runs;
  try {
    runs = (await (await api('library?images=0')).json()).runs ?? [];
  } catch {
    return undefined;
  }
  const newest = runs[0]?.id ?? null;
  const take = runs.find(run => {
    const output = run.outputs?.[0];
    return run.mediaType !== 'audio' && (output?.thumbUrl || (run.mediaType !== 'video' && output?.originalUrl));
  });
  if (!take) {
    shown = null;
    show(null, root);
    return newest;
  }
  if (shown === take.id) return newest;
  let kept = null;
  try {
    kept = JSON.parse(storage?.getItem(LIGHT) || 'null');
  } catch {
    // Illisible : refaite.
  }
  if (kept?.id !== take.id) {
    const image = new Image();
    image.decoding = 'async';
    image.src = take.outputs[0].thumbUrl || take.outputs[0].originalUrl;
    try {
      await image.decode();
    } catch {
      return newest;
    }
    kept = { id: take.id, ...lightImages(image) };
    try {
      storage?.setItem(LIGHT, JSON.stringify(kept));
    } catch {
      // Plein : refaite au prochain lancement.
    }
  }
  shown = take.id;
  show(kept, root);
  return newest;
}

// La tuile du favicon (logo/favicon-16.svg) : le croissant seul sur sa tuile sombre.
const TILE =
  "<rect width='16' height='16' rx='3.5' fill='#141318'/>" +
  "<path d='M2.85 5.56A5.7 5.7 0 1 0 13.15 5.56A5.15 5.15 0 0 1 2.85 5.56Z' fill='#EEE8DE'/>";

/**
 * Une prise prête pendant que la page est cachée (logo.md) : un voyant de la couleur d'accent dans le
 * coin de l'icône de l'onglet, à la place des icônes de la page, qui reviennent quand elle est revue.
 */
export function showTakeReady(doc = document) {
  const head = doc.head,
    links = [...head.querySelectorAll('link[rel~="icon"]')];
  if (!links.length || head.querySelector('link[data-take-ready]')) return;
  const accent =
    doc.defaultView?.getComputedStyle(doc.documentElement).getPropertyValue('--accent').trim() || '#d0cadd';
  const ready = doc.createElement('link');
  ready.rel = 'icon';
  ready.type = 'image/svg+xml';
  ready.dataset.takeReady = '';
  ready.href =
    'data:image/svg+xml,' +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>" +
        TILE +
        `<circle cx='12.7' cy='3.3' r='2.8' fill='${accent}' stroke='#141318' stroke-width='1'/></svg>`,
    );
  for (const link of links) link.remove();
  head.append(ready);
  const back = () => {
    if (doc.hidden) return;
    doc.removeEventListener('visibilitychange', back);
    ready.remove();
    head.append(...links);
  };
  doc.addEventListener('visibilitychange', back);
}
