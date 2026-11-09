import { convertKreaWorkflow, readWorkflowSource } from './native-workflow-conversion.mjs';
import { convertLongForge } from './longforge-conversion.mjs';

export async function importComfyWorkflow(sourceText, options) {
  const { source } = await readWorkflowSource(undefined, sourceText);
  const graph = source?.graph ?? source;
  const longforge =
    Array.isArray(source?.nodes) && source.nodes.some(node => node?.type === 'LongForgeLTXVideoSettings');
  const krea =
    graph &&
    typeof graph === 'object' &&
    !Array.isArray(graph) &&
    Object.values(graph).some(node => node?.class_type === 'CLIPLoader' && node.inputs?.type === 'krea2');
  if (longforge && krea)
    throw Object.assign(
      new Error('Le fichier mélange plusieurs formats de workflows. Exportez un seul workflow ComfyUI.'),
      { status: 400 },
    );
  if (!longforge && !krea)
    throw Object.assign(new Error('Ce workflow ComfyUI n’est pas encore compatible avec Atelier.'), { status: 400 });
  return (longforge ? convertLongForge : convertKreaWorkflow)(undefined, { ...options, sourceText });
}
