// Preloaded by tests/rescue-update.mjs (--import, through NODE_OPTIONS) into the update command it
// starts: GitHub answers from the files of the test, any other address is fetched as usual, and the
// processes started next (launcher, server) load nothing of it.
import { readFileSync } from 'node:fs';

const plan = JSON.parse(readFileSync(process.env.ATELIER_TEST_GITHUB, 'utf8'));
delete process.env.NODE_OPTIONS;
delete process.env.ATELIER_TEST_GITHUB;
const local = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const address = String(url);
  if (address.startsWith('https://api.github.com/')) return new Response(plan.sha);
  if (address.startsWith('https://raw.githubusercontent.com/')) return new Response(plan.packageJson);
  if (address.startsWith('https://codeload.github.com/')) return new Response(readFileSync(plan.archive));
  return local(url, options);
};
