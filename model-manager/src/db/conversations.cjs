// Repository conversations/messages.
//
// Toutes les valeurs venant du client passent par des paramètres $1..$n : aucune
// interpolation de chaîne, donc aucune injection SQL possible via le contenu
// d'un message ou un titre de conversation.

const { query, getPool } = require('./pool.cjs');

/** Liste des conversations, plus récentes d'abord. */
async function listConversations(limit = 50) {
  const result = await query(
    `SELECT c.id,
            c.title,
            c.model,
            -- workspace_id : permet à l'historique de regrouper visuellement les
            -- conversations d'un même espace de travail.
            c.workspace_id,
            c.created_at,
            c.updated_at,
            COALESCE(m.total, 0) AS message_count,
            m.last_at
       FROM conversations c
       LEFT JOIN (
         SELECT conversation_id,
                COUNT(*) AS total,
                MAX(created_at) AS last_at
           FROM messages
          GROUP BY conversation_id
       ) m ON m.conversation_id = c.id
      WHERE c.archived = false
      ORDER BY c.updated_at DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

async function getConversation(id) {
  const result = await query('SELECT * FROM conversations WHERE id = $1', [id]);
  return result.rows[0] || null;
}

/** Conversation + tous ses messages, dans l'ordre d'insertion. */
async function getConversationWithMessages(id) {
  const conversation = await getConversation(id);
  if (!conversation) return null;
  const messages = await listMessages(id);
  return { ...conversation, messages };
}

async function listMessages(conversationId) {
  const result = await query(
    `SELECT id, conversation_id, role, content, reasoning, model, error, position, created_at
       FROM messages
      WHERE conversation_id = $1
      ORDER BY position ASC`,
    [conversationId],
  );
  return result.rows;
}

async function createConversation({ title, model }) {
  const result = await query(
    'INSERT INTO conversations (title, model) VALUES ($1, $2) RETURNING *',
    [title || 'Nouvelle conversation', model || null],
  );
  return result.rows[0];
}

async function renameConversation(id, title) {
  const result = await query(
    'UPDATE conversations SET title = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [id, title],
  );
  return result.rows[0] || null;
}

/** Change le modèle d'une conversation sans toucher à son titre. */
async function setConversationModel(id, model) {
  const result = await query(
    'UPDATE conversations SET model = $2 WHERE id = $1 RETURNING *',
    [id, model],
  );
  return result.rows[0] || null;
}

async function deleteConversation(id) {
  // Les messages partent en cascade (ON DELETE CASCADE).
  const result = await query('DELETE FROM conversations WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

/**
 * Ajoute un message à la position indiquée.
 *
 * On réserve le rang dans une transaction pour éviter que deux requêtes
 * concurrentes n'obtiennent la même position (l'index unique
 * messages_position_idx rejeterait alors la seconde).
 */
async function addMessage(conversationId, message) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const positionResult = await client.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM messages WHERE conversation_id = $1',
      [conversationId],
    );
    const position = positionResult.rows[0].next;

    const result = await client.query(
      `INSERT INTO messages (conversation_id, role, content, reasoning, model, error, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        conversationId,
        message.role,
        message.content || '',
        message.reasoning || null,
        message.model || null,
        message.error || null,
        position,
      ],
    );

    // Le message du user clôt une conversation vide : on la dote d'un titre
    // lisible, sinon la liste d'historique affiche N fois « Nouvelle conversation ».
    if (message.role === 'user') {
      const conv = await client.query('SELECT title FROM conversations WHERE id = $1', [conversationId]);
      const currentTitle = conv.rows[0]?.title;
      if (currentTitle === 'Nouvelle conversation') {
        const derived = String(message.content || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (derived) {
          await client.query('UPDATE conversations SET title = $2 WHERE id = $1', [conversationId, derived]);
        }
      }
    }

    await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function deleteMessage(id) {
  const result = await query('DELETE FROM messages WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

module.exports = {
  listConversations,
  getConversation,
  getConversationWithMessages,
  listMessages,
  createConversation,
  renameConversation,
  setConversationModel,
  deleteConversation,
  addMessage,
  deleteMessage,
};
