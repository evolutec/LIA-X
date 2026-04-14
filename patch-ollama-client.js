const fs = require('fs');
const path = '/app/server/node_modules/ollama/dist/browser.cjs';
const text = fs.readFileSync(path, 'utf8');
// Ne rien patcher : le client Ollama natif utilise déjà /api/${endpoint}
// qui retourne NDJSON compatible avec parseJSON.
// /v1/chat/completions retourne SSE incompatible avec parseJSON.
console.log('Ollama client patch: no-op (native /api/ endpoints kept)');
