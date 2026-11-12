/**
 * The folders of a models directory. Atelier sorts its generation files as ComfyUI does, under
 * the same names: one directory then serves both, and the settings need a single path — the
 * models folder of a ComfyUI, or Atelier's own. (The chat models keep their own folders beside
 * them, LLMs and vision, which ComfyUI does not have.)
 */

/** The folders Atelier's own models directory holds: those in use, then those kept for later. */
export const MODEL_TREE = [
  'diffusion_models',
  'text_encoders',
  'vae',
  'loras',
  'upscale_models',
  'latent_upscale_models',
  'frame_interpolation',
  'diffusers',
  'checkpoints',
  'clip_vision',
  'controlnet',
  'audio_encoders',
];

/** Other folders ComfyUI reads the same kind of file from. */
export const ALIASES = {
  diffusion_models: ['unet', 'checkpoints'],
  text_encoders: ['clip'],
};

/** What Atelier called these folders before it took ComfyUI's names: files left there are still found. */
export const FORMER = {
  diffusion_models: 'checkpoints',
  text_encoders: 'LLMs',
  vae: 'VAE',
  loras: 'LoRa',
  diffusers: 'audio',
  latent_upscale_models: 'upscale_models',
};

/** Every name a kind of file may be filed under, the expected one first. */
export const namesFor = name => [...new Set([name, ...(ALIASES[name] ?? []), ...(FORMER[name] ? [FORMER[name]] : [])])];
