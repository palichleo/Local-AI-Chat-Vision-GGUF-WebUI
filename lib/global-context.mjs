import { problem } from './engine.mjs';
export function globalContext(value = '') {
  if (typeof value !== 'string' || value.length > 16000 || value.includes('\0'))
    throw problem('Les consignes sont limitées à 16 000 caractères.');
  return value;
}
