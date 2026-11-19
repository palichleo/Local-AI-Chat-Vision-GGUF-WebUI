/**
 * The name of each setting of a workflow as Paramètres › Workflows shows it (native-workflow-ui.mjs),
 * and of the values it shows by a word. (0.6.94) Read by the server too: a value it refuses, or a
 * value it needs and is not given, is said under that same name (lib/native-workflows.mjs), never by
 * its key in English (« steps is required »). (0.6.102) So is a value it leaves aside or brings within
 * its limits (the notes of lib/tool-catalog.mjs), and a setting of the Studio that has no name of its own.
 */
export const SETTING_NAMES = {
  prompt: 'Prompt',
  negative_prompt: 'Prompt négatif',
  seed: 'Seed',
  width: 'Largeur',
  height: 'Hauteur',
  steps: 'Étapes',
  cfg: 'Guidage',
  denoise: 'Débruitage',
  expandPrompt: 'Expansion du prompt',
  frames: 'Images vidéo',
  fps: 'Images par seconde',
  audio: 'Audio',
  stage: 'Brouillon / finale',
  start_strength: 'Influence de l’image de début',
  end_strength: 'Influence de l’image de fin',
  image_compression: 'Compression des références (CRF)',
  overlap_frames: 'Images de chevauchement',
  msr_frames: 'Durée latente des références MSR',
  msr_strength: 'Influence des références MSR',
  tile: 'Taille des tuiles (px, 0 = entière)',
  max_side: 'Plus grand côté de sortie (px, 0 = libre)',
  multiplier: 'Multiplicateur d’images',
  mode: 'Mode',
  lyrics: 'Paroles',
  seconds: 'Durée (secondes)',
  language: 'Langue des paroles',
  guidance_scale: 'Guidage',
  shift: 'Décalage (shift)',
  attention: 'Attention',
  sparse_attention: 'Attention creuse',
  sparse_keep: 'Part gardée par l’attention creuse (%)',
  sparse_start: 'Début de l’attention creuse',
  scale: 'Agrandissement par passe',
  passes: 'Passes',
  color_correction: 'Correction des couleurs',
  subject: 'Qui remplacer (en anglais)',
  reference_subject: 'Qui est le personnage (en anglais)',
  step_lora_strength: 'Intensité du LoRA d’étapes',
  identity_lora_strength: 'Intensité du LoRA d’identité',
};
export const CHOICE_NAMES = { draft: 'Brouillon', final: 'Vidéo finale', smooth: 'Fluide', slow_motion: 'Ralenti' };
/**
 * (0.6.128) What is part of a request: written or chosen at each creation, by the user in the Studio
 * or by Moodix AI in the chat (the prompt, the size, the length, the version, the words of a song,
 * who is who, how much an upscale enlarges, how much of an image to modify is redone). Everything
 * else a model declares is a setting of the model: Moodix gives it a value, the user alone changes
 * it (Paramètres › Modèles for good, the Studio for one creation), and Moodix AI never does.
 * Decisions of 19/11: « étape et guidage doivent toujours être réglables, mais jamais Moodix AI.
 * […] C’est valable pour tous les réglages. », then « le débruitage, la résolution, le temps doivent
 * encore être choisis par Moodix » while the model is offered to it (« Proposé à Moodix AI »).
 */
export const ASKED = new Set([
  'prompt',
  'lyrics',
  'language',
  'seconds',
  'seed',
  'width',
  'height',
  'frames',
  'denoise',
  'stage',
  'subject',
  'reference_subject',
  'scale',
  'passes',
  'max_side',
  'multiplier',
  'mode',
]);
export const isSetting = name => !ASKED.has(name);
/**
 * What a setting does, in a sentence, where its family says nothing of it (`help`, `note`): the « ? »
 * at the end of its line in the page of a model.
 */
export const SETTING_HELP = {
  steps: 'Nombre de passes de calcul. Plus il y en a, plus la création est longue.',
  cfg: 'À quel point la création suit le prompt. Trop haut, les couleurs saturent.',
  guidance_scale: 'À quel point la création suit le prompt.',
  shift: 'Répartit les étapes entre la composition d’ensemble (plus haut) et les détails (plus bas).',
  negative_prompt: 'Ce que les créations de ce modèle doivent éviter.',
  fps: 'Images par seconde des vidéos créées.',
  audio: 'Les vidéos sont créées avec leur son.',
};
