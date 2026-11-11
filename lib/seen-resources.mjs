/**
 * A prompt written without seeing the images it is about is empty or wrong (a "wooden staircase"
 * for a stone one in the clouds). When a generation call passes reference images the model has
 * not looked at in this conversation, they are shown to it first; it then writes its call again.
 */
const GENERATORS = new Set(['create_image', 'create_video']);

/** Active image resources this call passes and the conversation has never shown to the model. */
export function unseenResources(messages, catalog, call) {
  if (!Array.isArray(messages) || !GENERATORS.has(call?.function?.name)) return [];
  const passed = String(call.function.arguments ?? '');
  // The interface marks each image it shows with its resource; those copies last one turn, and
  // the result of the reading ("loaded", with the identifiers) stays in the conversation.
  const seen = new Set(messages.map(message => message?.resourceId).filter(Boolean));
  const loaded = messages
    .filter(message => message?.role === 'tool' && typeof message.content === 'string')
    .map(message => message.content)
    .filter(text => /"status"\s*:\s*"(?:loaded|nothing_generated)"/.test(text));
  return catalog.filter(
    item =>
      item.type === 'image' &&
      passed.includes(item.id) &&
      !seen.has(item.id) &&
      !loaded.some(text => text.includes(item.id)),
  );
}

/** What the model reads with the images. */
export const SEEN_NOTE =
  'Nothing was generated: you had not looked at these images yet. They are shown below. Make your call again now, ' +
  'writing the prompt from what you actually see in them.';
