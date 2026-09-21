# ─────────────────────────────────────────────────────────────────────────────
# tests/model-manager-phantom-models.test.cjs — Modèles fantômes (model-loader)
#
# Régression : le state hôte peut conserver running=true avec pid=null (GGUF
# supprimé ou processus mort). L'UI affichait alors des modèles « chargés »
# alors qu'aucun fichier n'existait dans le dossier de modèles de l'installeur.
#
# Usage : node tests\model-manager-phantom-models.test.cjs
# Code de sortie 0 = tout OK, 1 = au moins un échec.
#
# Le test EXTRAIT les fonctions réelles de model-manager/server.js (aucune copie
# de logique) : isProjectInstance / isLiveInstance / resolveActiveModel /
# buildLoadedModelList.
# ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'model-manager', 'server.js');
const src = fs.readFileSync(serverPath, 'utf8');

function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) { throw new Error(`Fonction introuvable: ${name}`); }
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { return src.slice(start, i + 1); }
    }
  }
  throw new Error(`Accolade fermante introuvable: ${name}`);
}

const code = [
  "const PROXY_MODEL_ID = 'lia-local';",
  extractFunction('isProjectInstance'),
  extractFunction('isLiveInstance'),
  extractFunction('resolveActiveModel'),
  extractFunction('buildLoadedModelList'),
  'module.exports = { isLiveInstance, resolveActiveModel, buildLoadedModelList };',
].join('\n\n');

const mod = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('module', 'exports', code)(mod, mod.exports);
const { isLiveInstance, resolveActiveModel, buildLoadedModelList } = mod.exports;

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) { failures += 1; }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      attendu=${e}\n      obtenu =${a}`}`);
}

const phantom = (model, port) => ({
  id: String(port), model, filename: `${model}.gguf`, port, pid: null, running: true,
  active: port === 12435, proxy_id: `lia-local-${port}`,
});

// 1. State hôte fantôme : running=true mais pid=null (processus/GGUF disparus)
const ghostRuntime = {
  running: true, pid: null, active_model: 'Qwopus3.5-9B-v3-GGUF', server_port: 12434,
  instances: [phantom('nomic-embed-text-v2-moe-latest', 12434), phantom('llama3.2-1b', 12436), phantom('Qwopus3.5-9B-v3-GGUF', 12435)],
};
check('fantômes: aucun modèle principal', resolveActiveModel(ghostRuntime), '');
check('fantômes: aucun modèle chargé', buildLoadedModelList(ghostRuntime).length, 0);

// 2. Instances indépendantes non-LIA (autre projet) => ignorées
const foreignRuntime = {
  running: true, pid: 4000, active_model: 'autre-projet',
  instances: [{ id: '9', model: 'autre-projet', port: 12999, pid: 4000, running: true, proxy_id: 'ollama' }],
};
check('projet tiers ignoré (chargés)', buildLoadedModelList(foreignRuntime).length, 0);

// 3. Instance vivante réelle => chargée et principale
const liveRuntime = {
  running: true, pid: 4242, active_model: 'Qwopus3.5-9B-v3-GGUF', server_port: 12435, started_at: '2026-09-18T10:00:00',
  instances: [{ id: '12435', model: 'Qwopus3.5-9B-v3-GGUF', filename: 'Qwopus3.5-9B-v3-GGUF.gguf', port: 12435, pid: 4242, running: true, active: true, proxy_id: 'lia-local-12435', context: 8192 }],
};
check('vivante: principal', resolveActiveModel(liveRuntime), 'Qwopus3.5-9B-v3-GGUF');
check('vivante: chargés', buildLoadedModelList(liveRuntime).map((m) => m.model), ['Qwopus3.5-9B-v3-GGUF']);

// 4. State vide / null
check('vide: instances null', buildLoadedModelList({ instances: null, running: false }).length, 0);
check('null: robuste', buildLoadedModelList(null).length, 0);

// 5. isLiveInstance direct
check('isLiveInstance(pid null)', isLiveInstance({ running: true, pid: null }), false);
check('isLiveInstance(pid 0/absent)', isLiveInstance({ running: true }), false);
check('isLiveInstance(pid 7)', isLiveInstance({ running: true, pid: 7 }), true);
check('isLiveInstance(running false)', isLiveInstance({ running: false, pid: 7 }), false);

console.log(failures === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${failures} TEST(S) EN ÉCHEC`);
process.exit(failures === 0 ? 0 : 1);
