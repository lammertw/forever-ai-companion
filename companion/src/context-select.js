// Sends the AI only the character sections the question can use. Big sections
// the question does not touch are left out and listed in "omittedSections";
// providers with tool support can fetch them on demand (get_character_data).
import { normalizeText } from './guide.js';

// Section -> words (English and Spanish, normalized) that make it relevant.
// Anything not listed here is always sent.
const TRIGGERS = {
  bank: ['bank', 'banco', 'bag', 'bolsa', 'sell', 'vend', 'store', 'guard', 'storage', 'inventor', 'junk', 'basura', 'free space', 'espacio', ],
  knownRecipes: ['recipe', 'receta', 'craft', 'make', 'fabric', 'hacer', 'profession', 'profesion', 'skill', 'alchemy', 'alquimia', 'blacksmith', 'herreria', 'tailor', 'sastre', 'leatherwork', 'peleteria', 'enchant', 'encant', 'engineer', 'ingenier', 'cook', 'cocin', 'first aid', 'primeros auxilios', 'reagent', 'reactivo', 'material', 'forge', 'smelt'],
  auctionPrices: ['auction', 'subasta', 'price', 'precio', 'worth', 'vale', 'valor', 'cost', 'cuesta', 'sell', 'vend', 'gold', 'oro', 'money', 'dinero', 'buy', 'compr', 'afford', 'profit', 'ganancia', 'barato', 'cheap', 'expensive', 'caro', ],
  knownFlightPaths: ['fly', 'flight', 'vuelo', 'volar', 'vuela', 'flightmaster', 'path', 'ruta', 'gryphon', 'grifo', 'wyvern', 'bat', 'hippogryph', 'hipogrifo', 'travel', 'viaj', 'get to', 'llegar', 'ir a', 'how do i go', 'como voy', 'route', 'boat', 'barco', 'zeppelin', 'zepelin', 'tram', 'portal', 'hearth', 'pied'],
  beastTraining: ['pet', 'mascota', 'beast', 'bestia', 'train', 'entren', 'tame', 'domar', 'hunter', 'cazador', 'stable', 'establo', 'growl', 'bite', 'claw'],
  stable: ['pet', 'mascota', 'stable', 'establo', 'tame', 'domar', 'hunter', 'cazador'],
  reputations: ['reputation', 'reputacion', 'faction', 'faccion', 'revered', 'honored', 'exalted', 'friendly', 'respetado', 'honorable', 'exaltado'],
  currencies: ['currency', 'moneda', 'badge', 'token', 'honor', 'emblem'],
  lockouts: ['lockout', 'reset', 'saved', 'guardado', 'dungeon', 'mazmorra', 'raid', 'banda', 'instance', 'instancia', ],
  recentlyCompletedQuests: ['quest', 'mision', 'misiones', 'complet', 'turned', 'entregu', 'chain', 'cadena', ],
  spells: ['spell', 'hechizo', 'ability', 'habilidad', 'rank', 'rango', 'rotation', 'rotacion', 'macro', 'train', 'entren', 'talent', 'talento', 'learn', 'aprend', 'dps', 'damage', 'dano', 'heal', 'cura', 'tank', 'kill', 'matar', 'fight', 'pelea', 'pull', 'kite', 'build', 'cast', 'lanz', 'cooldown', 'enfriamiento', 'mana', 'rage', 'furia', 'energy', 'energia', 'stance', 'postura', 'aura', 'totem', 'curse', 'maldicion', 'sting', 'trap', 'trampa', 'shot', 'disparo', 'stun', 'aturd', 'interrupt', 'interrump', 'level up', 'subir'],
  actionBars: ['bar', 'barra', 'bind', 'tecla', 'key', 'macro', 'drag', 'arrastr', 'rotation', 'rotacion', 'ability', 'habilidad', 'spell', 'hechizo', 'missing', 'falta', 'not on', 'no esta'],
  spellsNotOnBars: ['bar', 'barra', 'bind', 'tecla', 'key', 'macro', 'drag', 'arrastr', 'rotation', 'rotacion', 'ability', 'habilidad', 'spell', 'hechizo', 'missing', 'falta', 'not on', 'no esta'],
  skills: ['skill', 'weapon', 'arma', 'miss', 'fall', 'riding', 'monta', 'mount', 'languag', 'idioma', 'proficien', 'competencia', 'equip', 'wear', 'armor', 'armadura', 'bow', 'arco', 'sword', 'espada', 'mace', 'maza', 'axe', 'hacha', 'dagger', 'daga', 'staff', 'baston', 'gun', 'arma de fuego', 'crossbow', 'ballesta'],
};

export const SECTIONS = Object.keys(TRIGGERS);

// Open windows pull in the data they are asked about.
const SCREEN_NEEDS = {
  merchant: ['auctionPrices', 'bank'],
  auction: ['auctionPrices', 'bank'],
  trainer: ['spells', 'actionBars', 'skills', 'beastTraining', 'stable'],
  flightMap: ['knownFlightPaths'],
  loot: ['auctionPrices'],
  questReward: ['auctionPrices'],
};

function relevant(name, q, context) {
  const words = TRIGGERS[name] || [];
  // Triggers are word stems ("vend" matches "vender" but not "convend").
  if (words.some((w) => q.includes(` ${w}`))) return true;
  const screen = context.screen && typeof context.screen === 'object' ? Object.keys(context.screen) : [];
  const open = [...screen, ...Object.keys(context).filter((k) => SCREEN_NEEDS[k])];
  return open.some((k) => (SCREEN_NEEDS[k] || []).includes(name));
}

// -> { context, omitted: [section names] }. `context` is a copy with the
// omitted sections replaced by an "omittedSections" list.
export function selectContext(context, question) {
  if (!context || typeof context !== 'object') return { context, omitted: [] };
  const q = normalizeText(question);
  const omitted = [];
  const out = {};
  for (const [key, value] of Object.entries(context)) {
    if (TRIGGERS[key] && value != null && !relevant(key, q, context)) omitted.push(key);
    else out[key] = value;
  }
  if (omitted.length) out.omittedSections = omitted;
  return { context: out, omitted };
}

// For the get_character_data tool: the requested sections of the full context.
export function pickSections(context, names) {
  const out = {};
  for (const n of Array.isArray(names) ? names : []) {
    if (SECTIONS.includes(n) && context && Object.hasOwn(context, n)) out[n] = context[n];
  }
  return out;
}
