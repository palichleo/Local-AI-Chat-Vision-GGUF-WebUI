import { readFileSync } from 'node:fs';
import { problem } from './engine.mjs';

// Tool names a stored conversation may contain: current generation verbs, earlier names and local readers.
const TOOL_NAMES = new Set([
  ...Object.keys(JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'))),
  'generate_image',
  'generate_video',
  'comfy_generate_image',
  'comfy_generate_video',
  'local_read_resource',
  'local_read_output',
]);

export function nativeFields(message) {
  const result = {};
  if (message.role === 'tool') {
    if (typeof message.tool_call_id !== 'string' || !/^[-A-Za-z0-9_]{1,128}$/.test(message.tool_call_id))
      throw problem('Identifiant d’appel invalide.');
    result.tool_call_id = message.tool_call_id;
  }
  if (message.tool_calls !== undefined) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length !== 1)
      throw problem('Appel de fonction invalide.');
    result.tool_calls = message.tool_calls.map(call => {
      if (
        call?.type !== 'function' ||
        !/^[-A-Za-z0-9_]{1,128}$/.test(call.id) ||
        !TOOL_NAMES.has(call.function?.name) ||
        typeof call.function.arguments !== 'string' ||
        call.function.arguments.length > 16000
      )
        throw problem('Appel de fonction invalide.');
      try {
        JSON.parse(call.function.arguments);
      } catch {
        throw problem('Paramètres d’appel invalides.');
      }
      return {
        id: call.id,
        type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments },
      };
    });
  }
  return result;
}
