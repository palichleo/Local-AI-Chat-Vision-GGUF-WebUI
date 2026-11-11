/**
 * The Studio: the creation tools used by hand, without the chat model. Its results are kept
 * like those of a conversation, under one fixed identifier that is no conversation's.
 */
export const STUDIO_ID = '57ad1000-0000-4000-8000-000000000001';
/** What the Studio may start itself: the click on « Générer » is the confirmation. */
export const STUDIO_VERBS = ['create_image', 'create_video', 'extend_video', 'create_audio', 'upscale', 'interpolate'];

// Starting points drawn at random, so two styles asked for with an empty box differ.
const SEEDS = {
  image: [
    ['35 mm film photography', 'gouache illustration', 'ink and watercolour', 'matte 3D render', 'risograph print'],
    ['oil painting', 'large-format studio photograph', 'cel animation', 'charcoal drawing', 'collage of cut paper'],
    ['muted earth palette', 'neon on deep black', 'pastel haze', 'two-colour print', 'saturated primaries'],
    ['hard noon light', 'overcast soft light', 'single window light', 'golden backlight', 'cold moonlight'],
    ['1920s', '1950s', '1970s', '1990s', 'near future'],
  ],
  video: [
    ['16 mm film', 'anamorphic 35 mm', 'handheld digital', 'stop-motion', 'hand-drawn animation', 'VHS tape'],
    ['slow dolly moves', 'locked-off tripod shots', 'drifting handheld', 'long steady glides', 'whip pans'],
    [
      'bleach-bypass grade',
      'warm tungsten grade',
      'teal and amber grade',
      'desaturated cold grade',
      'vivid technicolor',
    ],
    ['shallow depth of field', 'deep focus', 'heavy grain', 'soft halation', 'crisp and clean'],
    ['1960s', '1980s', '2000s', 'contemporary', 'near future'],
  ],
};
const pick = list => list[Math.floor(Math.random() * list.length)];

/** The messages that make the chat model write one short style line, from an idea or from nothing. */
export function styleMessages(description, media = 'image') {
  const video = media === 'video',
    idea = typeof description === 'string' ? description.trim().slice(0, 2000) : '';
  const system =
    `You write the style line of a prompt for ${video ? 'a video' : 'an image'} generator. Answer with one line only, ` +
    `in English, 30 words at most: ${video ? 'the look of the footage (film stock or medium, lens, colour grade, light, how the camera moves)' : 'the medium, the palette, the light, the texture, the era or influence'}, ` +
    'as concrete craft terms separated by commas. No subject, no action, no people, no quotes, no preamble, no explanation.';
  const seeds = SEEDS[video ? 'video' : 'image'];
  const user = idea
    ? `Write the style line for this description: ${idea}`
    : `Invent a distinctive style. Build it around: ${[pick(seeds[0].concat(seeds[1])), pick(seeds[2]), pick(seeds[3]), pick(seeds[4])].join('; ')}.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** The model's answer as one clean line: no thinking block, quotes, label or line breaks; 400 characters at most. */
export function styleLine(text) {
  let line = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, ' ')
    .split('\n')
    .map(part => part.trim())
    .filter(Boolean)
    .join(' ');
  const quotes = /^["'«“\s]+|["'»”\s]+$/g;
  line = line
    .replace(quotes, '')
    .replace(/^style(?: line)?\s*:\s*/i, '')
    .replace(quotes, '');
  return line.slice(0, 400).trim();
}
