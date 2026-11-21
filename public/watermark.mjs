/**
 * (0.6.187) Le watermark des vidéos qui sortent de Moodix (claude_design/maquettes/watermark-maquette.md) :
 * l'export de la Bobine, « Un seul fichier » comme « Un fichier par prise ». Jamais dans le fichier
 * d'une prise : Moodix s'en sert pour les suites, les interpolations et la Bobine.
 *
 * Réglé seulement dans Paramètres › Interface (décision du 21/11 : « réglable uniquement dans
 * paramètres › interface », L'Éclipse par défaut). Lu par le serveur à chaque export (server.mjs) et
 * par la page (interface-settings.mjs) ; le moteur le pose (runner/video/montage.py).
 */
export const WATERMARKS = ['aucun', 'eclipse', 'eclipse-nom'];
export const WATERMARK_NAMES = { aucun: 'Aucun', eclipse: 'L’Éclipse', 'eclipse-nom': 'L’Éclipse et le nom' };
/** Sans choix enregistré : L'Éclipse. */
export const WATERMARK_DEFAULT = 'eclipse';

/** Le watermark enregistré, ou celui par défaut quand il n'y en a pas (ou qu'il est illisible). */
export function watermarkSetting(value) {
  return WATERMARKS.includes(value) ? value : WATERMARK_DEFAULT;
}
