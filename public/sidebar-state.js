// Read in <head>, before the first paint: the sidebar comes up folded or unfolded as it was left
// (public/sidebar-fold.mjs), never unfolded and then folded. Unreadable storage: unfolded.
try {
  if (localStorage.getItem('moodix.sidebar') === 'collapsed') document.documentElement.dataset.sidebar = 'collapsed';
} catch {
  // A private window, storage switched off: the sidebar unfolded.
}
