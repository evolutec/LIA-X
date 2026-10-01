// Test de la couche base de données hors conteneur model-loader.
//
// Usage : node scripts/test-db.js
// Prérequis : le conteneur lia-postgres tourne sur le réseau lia-network.
// Ce script s'exécute donc lui-même dans un conteneur Node du même réseau.

const { checkConnection, closePool } = require('../src/db/pool.cjs');
const { applySchema, waitForDatabase } = require('../src/db/migrate.cjs');
const conversations = require('../src/db/conversations.cjs');

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  OK   ${label}`);
  } else {
    failures += 1;
    console.log(`  ECHEC ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

(async () => {
  console.log('[1] connectivité');
  const ready = await waitForDatabase(20000, 1000);
  check('PostgreSQL répond', ready);
  if (!ready) {
    await closePool();
    process.exit(1);
  }

  console.log('[2] application du schéma');
  const applied = await applySchema();
  check('schéma appliqué', applied.applied, applied.reason);

  console.log('[3] extension vector');
  const { query } = require('../src/db/pool.cjs');
  const ext = await query(
    "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto') ORDER BY extname",
  );
  const names = ext.rows.map((r) => r.extname);
  check('pgvector installé', names.includes('vector'), names.join(','));
  check('pgcrypto installé', names.includes('pgcrypto'), names.join(','));

  console.log('[4] CRUD conversation');
  const conv = await conversations.createConversation({ title: 'Test LIA-X', model: 'lia-local' });
  check('création', Boolean(conv.id));
  const reloaded = await conversations.getConversation(conv.id);
  check('lecture', reloaded.title === 'Test LIA-X');

  console.log('[5] messages et positions');
  const m1 = await conversations.addMessage(conv.id, { role: 'user', content: 'Bonjour, quelle heure est-il ?' });
  const m2 = await conversations.addMessage(conv.id, { role: 'assistant', content: 'Il est midi.', model: 'lia-local' });
  const m3 = await conversations.addMessage(conv.id, {
    role: 'user',
    content: 'Merci',
    reasoning: 'court raisonnement',
  });
  check('position incrémentale', m1.position === 0 && m2.position === 1 && m3.position === 2,
    `${m1.position}/${m2.position}/${m3.position}`);
  const messages = await conversations.listMessages(conv.id);
  check('3 messages', messages.length === 3, `obtenu ${messages.length}`);
  check('raisonnement conservé', messages[2].reasoning === 'court raisonnement');

  console.log('[6] titre auto depuis le premier message');
  const conv2 = await conversations.createConversation({});
  await conversations.addMessage(conv2.id, { role: 'user', content: 'Explique pgvector en une phrase' });
  const conv2b = await conversations.getConversation(conv2.id);
  check('titre déduit', conv2b.title === 'Explique pgvector en une phrase', conv2b.title);

  console.log('[7] liste et comptage');
  const list = await conversations.listConversations();
  const entry = list.find((c) => c.id === conv.id);
  check('conversation listée', Boolean(entry));
  check('compteur de messages', Number(entry.message_count) === 3, `compte ${entry.message_count}`);

  console.log('[8] renommage et suppression');
  const renamed = await conversations.renameConversation(conv.id, 'Renommée');
  check('renommage', renamed.title === 'Renommée', renamed.title);
  const deleted = await conversations.deleteConversation(conv.id);
  check('suppression', deleted);
  const orphan = await conversations.getConversation(conv.id);
  check('conversation disparue', orphan === null);
  const cascade = await conversations.listMessages(conv.id);
  check('messages supprimés en cascade', cascade.length === 0, `${cascade.length} restant(s)`);

  console.log('[9] resistance a l injection SQL');
  const evil = await conversations.addMessage(conv2.id, {
    role: 'user',
    content: "'); DROP TABLE conversations; --",
  });
  check('contenu hostile stocké verbatim', evil.content === "'); DROP TABLE conversations; --");
  const survived = await conversations.listConversations();
  check('table conversations intacte', survived.length > 0);

  console.log('[10] vecteur pgvector');
  const vec = await query('SELECT $1::vector AS v', ['[1,2,3]']);
  check('cast vector', vec.rows[0].v === '[1,2,3]', String(vec.rows[0].v));

  await conversations.deleteConversation(conv2.id);
  await closePool();

  console.log('');
  if (failures === 0) {
    console.log('TOUS LES TESTS PASSENT');
    process.exit(0);
  }
  console.log(`${failures} ECHEC(S)`);
  process.exit(1);
})();
