// Test the AI configuration without the game:
//   npm run ask -- "Which dungeon do you recommend?"
// Uses sample/sample-context.json as the character.
import { loadConfig } from '../src/config.js';
import { sampleContext } from '../src/assets.js';
import { buildMessages, buildSystemParts, cleanAnswer, loadKnowledge } from '../src/prompt.js';
import { ask, canFetchData } from '../src/providers.js';

const question = process.argv.slice(2).join(' ') || 'What is the best dungeon I can run right now?';
const cfg = loadConfig();
const req = { id: 'test', question, context: sampleContext(), history: [] };

console.log(`Proveedor: ${cfg.provider}\nPregunta: ${question}\n`);
try {
  const { text, model } = await ask(cfg, buildSystemParts(loadKnowledge(), undefined, { dataTool: canFetchData(cfg) }), buildMessages(req, { select: cfg.contextSelect !== false }), req);
  console.log(`[${model}]\n${cleanAnswer(text)}`);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
