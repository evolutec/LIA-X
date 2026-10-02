// Pool PostgreSQL — source de vérité pour l'historique des conversations.
//
// Le conteneur lia-x est sans état pour tout ce qui concerne les données :
// si la base est absente ou injoignable, l'application doit DÉMARRER QUAND MÊME et
// dégrader proprement (chat utilisable, historique en mémoire). C'est pourquoi
// ce module ne lève pas au chargement : il expose isDbAvailable() et laisse les
// appelants décider.

const { Pool } = require('pg');

const config = {
  host: process.env.POSTGRES_HOST || 'lia-postgres',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || 'lia',
  user: process.env.POSTGRES_USER || 'lia',
  // Mot de passe local au réseau Docker privé `lia-network`. Ce n'est pas un
  // secret de production : le conteneur postgres n'expose aucun port sur
  // l'hôte, il n'est joignable que depuis le réseau privé.
  password: process.env.POSTGRES_PASSWORD || 'lia_local_dev',
  max: Number(process.env.POSTGRES_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

let pool = null;
let available = false;
let lastError = null;

function getPool() {
  if (!pool) {
    pool = new Pool(config);
    // Un client qui tombe (restart de postgres) ne doit pas faire tomber le
    // process Node : on le marque indisponible et on laisse le pool se
    // reconnecter tout seul à la demande suivante.
    pool.on('error', (error) => {
      available = false;
      lastError = error;
      console.error('[db] erreur du pool PostgreSQL :', error.message);
    });
  }
  return pool;
}

async function query(text, params) {
  const client = await getPool().connect();
  try {
    // Requêtes paramétrées ($1, $2...) : jamais de concaténation de valeurs.
    const result = await client.query(text, params);
    available = true;
    return result;
  } finally {
    client.release();
  }
}

/** Test de connectivité, à appeler au démarrage et via /api/db/health. */
async function checkConnection() {
  try {
    const result = await query('SELECT 1 AS ok');
    available = result.rows[0]?.ok === 1;
    return { available, error: null };
  } catch (error) {
    available = false;
    lastError = error;
    return { available: false, error: error.message };
  }
}

function isDbAvailable() {
  return available;
}

function getLastError() {
  return lastError ? lastError.message : null;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    available = false;
  }
}

module.exports = { getPool, query, checkConnection, isDbAvailable, getLastError, closePool };
