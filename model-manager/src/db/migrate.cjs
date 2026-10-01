// Application du schéma au démarrage du conteneur model-loader.
//
// Le schéma est idempotent (CREATE ... IF NOT EXISTS) et versionné : la table
// schema_migrations trace les versions déjà appliquées pour qu'un futur
//rajout de colonne puisse être encadré. Un échec de migration n'empêche PAS le
//démarrage : le chat doit rester utilisable même si la base est absente.

const fs = require('fs');
const path = require('path');
const { query, checkConnection, getPool } = require('./pool.cjs');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * Migration 002 : suivi de l'ingestion asynchrone.
 *
 * `CREATE TABLE IF NOT EXISTS` de schema.sql n'ajoute aucune colonne à une table
 * déjà créée sur un disque existant : une installation qui a déjà lancé la
 * version 001 conserverait donc l'ancienne structure. On ajoute donc chaque
 * colonne explicitement, en ignorant celles qui existent déjà, ce qui rend
 * l'opération idempotente.
 */
async function applyAsyncIngestMigration() {
  // Sur une base antérieure au renommage, la table s'appelle encore
  // « documents ». Sur une base neuve, schema.sql a déjà créé « files » avec
  // ces colonnes : il ne reste alors que l'index à poser. Sans cette
  // distinction, l'ALTER viserait une table inexistante et le démarrage
  // serait signalé en échec.
  const legacy = await hasLegacySchema();
  const table = legacy ? 'documents' : 'files';
  const index = legacy
    ? 'documents_ingest_pending_idx'
    : 'files_ingest_pending_idx';

  const columns = [
    ['ingest_status', "TEXT NOT NULL DEFAULT 'ready'"],
    ['total_chunks', 'INTEGER NOT NULL DEFAULT 0'],
    ['done_chunks', 'INTEGER NOT NULL DEFAULT 0'],
    ['error_detail', 'TEXT'],
    ['started_at', 'TIMESTAMPTZ'],
    ['finished_at', 'TIMESTAMPTZ'],
  ];

  try {
    // ADD COLUMN IF NOT EXISTS est idempotent : inutile de tester l'existence
    // au préalable, PostgreSQL s'en charge.
    for (const [name, definition] of columns) {
      // Le nom de colonne vient d'une liste litterale ci-dessus, jamais de
      // saisie utilisateur : il n'a pas besoin d'etre parametre.
      // eslint-disable-next-line no-await-in-loop
      await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${definition}`);
    }
    await query(
      `CREATE INDEX IF NOT EXISTS ${index} ON ${table} (started_at)
        WHERE ingest_status IN ('pending', 'running')`,
    );
    await query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      ['002_async_ingest'],
    );
    console.log(`[db] migration appliquee (version 002_async_ingest, table ${table})`);
    return { applied: true, reason: null };
  } catch (error) {
    console.error('[db] echec migration 002_async_ingest :', error.message);
    return { applied: false, reason: error.message };
  }
}

/**
 * Migration 006 : arborescence et métadonnées d'affichage.
 *
 * L'explorateur de fichiers a besoin de trois choses que le modèle plat
 * n'avait pas :
 *  - folders.parent_id, pour imbriquer les dossiers et naviguer dans l'arbre ;
 *  - files.size_bytes, pour la colonne « Taille » ;
 *  - files.updated_at, pour la colonne « Modifié le ».
 *
 * Le nom du dossier perd sa contrainte UNIQUE globale : elle est incompatible
 * avec une arborescence, puisque deux sous-dossiers peuvent legitimement
 * porter le même nom dans deux dossiers différents. L'unicité est désormais
 * vérifiée par l'application sur le couple (parent, nom), ce qui permet un
 * message d'erreur lisible.
 *
 * Toutes les étapes sont idempotentes (IF EXISTS / IF NOT EXISTS) et la
 * migration est transactionnelle.
 */
async function applyExplorerMigration() {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    // Contrainte d'unicité globale : elle est incompatible avec une arborescence
    // (deux sous-dossiers de même nom doivent pouvoir coexister). On la retire
    // avant d'ajouter les colonnes.
    //
    // Le nom de la contrainte suit celui de la table au moment de sa création.
    // Or le renommage 005 a renommé la table `collections` en `folders` SANS
    // renommer sa contrainte : elle porte encore le nom `collections_name_key`.
    // On supprime donc les deux noms, car une base neuve n'aura que le second.
    await client.query('ALTER TABLE IF EXISTS folders DROP CONSTRAINT IF EXISTS folders_name_key');
    await client.query('ALTER TABLE IF EXISTS folders DROP CONSTRAINT IF EXISTS collections_name_key');

    // Arborescence des dossiers.
    await client.query('ALTER TABLE IF EXISTS folders ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES folders(id) ON DELETE CASCADE');
    await client.query('CREATE INDEX IF NOT EXISTS folders_parent_idx ON folders (parent_id)');
    await client.query('CREATE INDEX IF NOT EXISTS folders_name_idx ON folders (lower(name))');

    // Fichiers : taille et date de modification.
    await client.query('ALTER TABLE IF EXISTS files ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0');
    // Les fichiers existants n'ont pas de date de modification distincte :
    // created_at est la seule information disponible, on la recopie.
    await client.query('ALTER TABLE IF EXISTS files ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ');
    await client.query('UPDATE files SET updated_at = created_at WHERE updated_at IS NULL');

    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      ['006_explorer'],
    );
    await client.query('COMMIT');
    console.log('[db] migration appliquée (version 006_explorer)');
    return { applied: true, reason: null };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[db] rollback 006 impossible :', rollbackError.message);
    }
    console.error('[db] échec migration 006_explorer :', error.message);
    return { applied: false, reason: error.message };
  } finally {
    client.release();
  }
}

/**
 * La base contient-elle encore le schéma d'avant le renommage (« collections »
 * et « documents ») ?
 *
 * Les migrations 003, 004 et 005 servent uniquement à transformer une base
 * existante. Or schema.sql crée désormais directement le schéma final
 * (dossiers / fichiers). Sur une base neuve, il n'y a donc rien à migrer :
 * sans cette détection, la migration 003 échouerait en cherchant la table
 * « collections », qui n'existe plus, et le démarrage serait bloqué.
 */
async function hasLegacySchema() {
  const result = await query(`
    SELECT to_regclass('public.collections') AS reg
  `);
  return Boolean(result.rows[0] && result.rows[0].reg);
}

/**
 * Migration 003 : collections par conversation.
 *
 * Avant, les collections cochées dans l'interface s'appliquaient à toutes les
 * conversations : documenter un projet A venait polluer la recherche du projet
 * B. Chaque conversation porte désormais sa propre sélection.
 *
 * Le lien est une table de jonction et non une colonne : une conversation peut
 * legitimately viser plusieurs collections à la fois.
 */
async function applyConversationCollectionsMigration() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS conversation_collections (
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        collection_id   UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        PRIMARY KEY (conversation_id, collection_id)
      )
    `);
    // Index inverse : lors de la suppression d'une collection, PostgreSQL doit
    // trouver les lignes de jonction à effacer sans parcourir toute la table.
    await query(
      'CREATE INDEX IF NOT EXISTS conversation_collections_collection_idx ON conversation_collections (collection_id)',
    );
    await query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      ['003_conversation_collections'],
    );
    console.log('[db] migration appliquée (version 003_conversation_collections)');
    return { applied: true, reason: null };
  } catch (error) {
    console.error('[db] échec migration 003_conversation_collections :', error.message);
    return { applied: false, reason: error.message };
  }
}

/**
 * Migration 004 : espaces de travail.
 *
 * Hiérarchie cible : espace de travail → conversations + collections.
 * L'ancien modèle autorisait une conversation à choisir ses collections
 * (migration 003), plus précis mais peu praticable : il fallait répéter la même
 * sélection dans chaque conversation d'un même projet.
 *
 * Un espace regroupe plusieurs conversations et pointe vers une ou plusieurs
 * collections. La table conversation_collections de la migration 003 est
 * conservée : elle sert aux chats « hors espace » et évite de détruire des
 * données déjà enregistrées. La résolution effective est la réunion des deux.
 */
/**
 * Migration 005 : « collections » devient « dossiers ».
 *
 * Simple renommage sémantique, sans toucher aux données : l'utilisateur
 * manipule des dossiers de documents, pas des collections de fragments. On
 * renomme donc la table puis chaque colonne et index qui la référencent.
 *
 * Trois précautions :
 *  - chaque opération est idempotente (on teste information_schema avant) : la
 *    migration peut être rejouée sans effet ;
 *  - le tout est encadré par une transaction : soit tout réussit, soit la base
 *    reste dans son état d'avant ;
 *  - une copie de sécurité est créée avant la première écriture. Les données
 *    ne bougent pas, mais une restauration reste possible si un déploiement
 *    antérieur parle encore « collections ».
 */
async function applyFoldersMigration() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Copie de sécurité : rend l'opération réversible. Une seule fois, si la
    // table existe déjà, on n'écrase pas la sauvegarde d'un déploiement
    // antérieur.
    // eslint-disable-next-line no-await-in-loop
    const backup = await client.query(`
      SELECT to_regclass('public.collections') AS reg
    `);
    if (backup.rows[0].reg) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(`
        CREATE TABLE IF NOT EXISTS collections_backup_005 AS SELECT * FROM collections
      `);
      // eslint-disable-next-line no-await-in-loop
      await client.query(`
        CREATE TABLE IF NOT EXISTS documents_backup_005 AS SELECT * FROM documents
      `);
    }

    // La table principale.
    // eslint-disable-next-line no-await-in-loop
    await client.query('ALTER TABLE IF EXISTS collections RENAME TO folders');

    // Colonnes qui pointent vers elle, dans chaque table concernee.
    // Les tables sont traitees AVANT leur éventuel renommage, pour que la
    // colonne soit encore celle attendue.
    const columnRenames = [
      ['documents', 'collection_id', 'folder_id'],
      ['workspace_collections', 'collection_id', 'folder_id'],
      ['conversation_collections', 'collection_id', 'folder_id'],
      ['chunks', 'document_id', 'file_id'],
    ];
    for (const [table, from, to] of columnRenames) {
      // eslint-disable-next-line no-await-in-loop
      const exists = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, from],
      );
      if (exists.rowCount > 0) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`,
        );
      }
    }

    // Tables de jonction : le nom porte lui aussi « collection ».
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      'ALTER TABLE IF EXISTS workspace_collections RENAME TO workspace_folders',
    );
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      'ALTER TABLE IF EXISTS conversation_collections RENAME TO conversation_folders',
    );

    // « documents » devient « files » : l'utilisateur manipule des fichiers
    // dans un dossier, et l'explorateur de fichiers parle de fichiers. La
    // table chunks pointe deja vers file_id (renomme ci-dessus).
    // eslint-disable-next-line no-await-in-loop
    await client.query('ALTER TABLE IF EXISTS documents RENAME TO files');

    // Index : on les recree sous le nouveau nom (le DROP est sans effet si
    // l'ancien n'existe pas).
    const indexRenames = [
      ['workspace_collections_collection_idx', 'workspace_folders_folder_idx', 'workspace_folders', 'folder_id'],
      ['conversation_collections_collection_idx', 'conversation_folders_folder_idx', 'conversation_folders', 'folder_id'],
    ];
    for (const [oldName, newName, table, column] of indexRenames) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(`DROP INDEX IF EXISTS ${oldName}`);
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${newName} ON ${table} (${column})`,
      );
    }

    // Contrainte de cle primaire des tables de jonction : elle porte le nom de
    // l'ancienne colonne, PostgreSQL ne la renomme pas tout seul.
    // eslint-disable-next-line no-await-in-loop
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'workspace_collections_pkey'
            AND conrelid = 'workspace_folders'::regclass
        ) THEN
          ALTER TABLE workspace_folders RENAME CONSTRAINT workspace_collections_pkey
            TO workspace_folders_pkey;
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'conversation_collections_pkey'
            AND conrelid = 'conversation_folders'::regclass
        ) THEN
          ALTER TABLE conversation_folders RENAME CONSTRAINT conversation_collections_pkey
            TO conversation_folders_pkey;
        END IF;
      END $$
    `);

    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      ['005_folders'],
    );
    await client.query('COMMIT');
    console.log('[db] migration appliquée (version 005_folders)');
    return { applied: true, reason: null };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[db] rollback 005 impossible :', rollbackError.message);
    }
    console.error('[db] échec migration 005_folders :', error.message);
    return { applied: false, reason: error.message };
  } finally {
    client.release();
  }
}

async function applyWorkspacesMigration() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name        TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Collection(s) rattachee(s) a l'espace.
    await query(`
      CREATE TABLE IF NOT EXISTS workspace_collections (
        workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        PRIMARY KEY (workspace_id, collection_id)
      )
    `);
    await query(
      'CREATE INDEX IF NOT EXISTS workspace_collections_collection_idx ON workspace_collections (collection_id)',
    );
    // Conversations de l'espace. SET NULL : supprimer un espace ne doit pas
    // supprimer les conversations qu'il contenait, elles sont partagees avec
    // l'historique et restent accessibles.
    await query(
      'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL',
    );
    await query(
      'CREATE INDEX IF NOT EXISTS conversations_workspace_idx ON conversations (workspace_id)',
    );

    await query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      ['004_workspaces'],
    );
    console.log('[db] migration appliquée (version 004_workspaces)');
    return { applied: true, reason: null };
  } catch (error) {
    console.error('[db] échec migration 004_workspaces :', error.message);
    return { applied: false, reason: error.message };
  }
}


/**
 * Migration 007 - modeles epingles (residence permanente en VRAM).
 *
 * Un modele epingle demarre SANS --sleep-idle-seconds : llama-server ne le
 * decharge donc jamais, il reste entierement charge et repond sans latence de
 * rechargement. L etat est persiste pour survivre au redemarrage du controleur
 * comme au redemarrage du conteneur.
 *
 * On identifie un modele par son NOM DE FICHIER : c est la seule cle stable
 * entre le disque des modeles, le runtime state du controleur et cette table
 * (un id interne disparaitrait des que le fichier est renomme ou deplace).
 */
async function applyPinnedModelsMigration() {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS pinned_models (
        filename   TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      ['007_pinned_models'],
    );
    await client.query('COMMIT');
    console.log('[db] migration appliquee (version 007_pinned_models)');
    return { applied: true, reason: null };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[db] rollback 007 impossible :', rollbackError.message);
    }
    console.error('[db] echec migration 007_pinned_models :', error.message);
    return { applied: false, reason: error.message };
  } finally {
    client.release();
  }
}
async function applySchema() {
  const health = await checkConnection();
  if (!health.available) {
    console.warn('[db] PostgreSQL injoignable, schéma non appliqué :', health.error);
    return { applied: false, reason: health.error };
  }

  // CREATE EXTENSION exige des droits de superutilisateur. Le rôle `lia` n'est
  // pas superutilisateur : on tente quand même, et on n'échoue pas si c'est
  // refusé (l'extension peut être déjà installée dans l'image, ou être
  // installable par un rôle dédié). Les tables qui suivent n'ont pas besoin
  // devector tant que le RAG n'est pas alimenté.
  try {
    await query('CREATE EXTENSION IF NOT EXISTS vector');
    await query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  } catch (error) {
    console.warn('[db] extensions non créées :', error.message);
  }

  // schema_migrations doit exister AVANT toute insertion de version, y compris
  // celle de la migration 002 qui est appelée plus bas.
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Les migrations 002 à 005 doivent passer AVANT schema.sql.
  //
  // schema.sql décrit le schéma FINAL (dossiers / fichiers). Sur une base
  // héritée, les tables portent encore les anciens noms : l'appliquer d'abord
  // ferait échouer « CREATE INDEX ... ON chunks (file_id) », car la colonne
  // s'appelle encore document_id à ce stade. Les migrations remettent d'abord
  // la base au vocabulaire final, puis schema.sql n'a plus qu'à créer ce qui
  // manque réellement (il est idempotent).
  const legacy = await hasLegacySchema();

  if (legacy) {
    console.log('[db] base au schéma ancien détectée : migrations 002 à 005 appliquées');

    const migration = await applyAsyncIngestMigration();
    if (!migration.applied) {
      return migration;
    }

    // Chaque conversation porte sa propre sélection de dossiers.
    const conversationFolders = await applyConversationCollectionsMigration();
    if (!conversationFolders.applied) {
      return conversationFolders;
    }

    // Espaces de travail (espace → conversations + dossiers).
    const workspacesMigration = await applyWorkspacesMigration();
    if (!workspacesMigration.applied) {
      return workspacesMigration;
    }

    // « collections » devient « dossiers », puis « documents » devient « files ».
    const foldersMigration = await applyFoldersMigration();
    if (!foldersMigration.applied) {
      return foldersMigration;
    }
  } else {
    // Base neuve : schema.sql va créer le schéma final. Les versions sont
    // tout de même enregistrées pour que le journal reste cohérent.
    await query(
      `INSERT INTO schema_migrations (version) VALUES ($1), ($2), ($3), ($4)
        ON CONFLICT (version) DO NOTHING`,
      ['002_async_ingest', '003_conversation_collections', '004_workspaces', '005_folders'],
    );
  }

  // La migration 006 doit passer AVANT schema.sql, et non après.
  //
  // schema.sql crée les index folders_parent_idx et folders_name_idx, qui
  // portent sur la colonne parent_id. Sur une base existante, CREATE TABLE IF
  // NOT EXISTS n'ajoute aucune colonne : les index échoueraient donc sur une
  // colonne absente. La migration crée d'abord la colonne, schema.sql a alors
  // tout ce qu'il lui faut.
  //
  // Sur une base neuve, les ALTER ... IF EXISTS sont sans effet (les tables
  // n'existent pas encore) et les tables sont créées par schema.sql avec
  // parent_id dès la définition : la migration reste donc un no-op sûr.
  const explorerMigration = await applyExplorerMigration();
  if (!explorerMigration.applied) {
    return explorerMigration;
  }

  // Modeles epingles : la table n est pas dans schema.sql car elle n a aucun
  // rapport avec le RAG ; elle vit uniquement dans sa propre migration.
  const pinnedMigration = await applyPinnedModelsMigration();
  if (!pinnedMigration.applied) {
    return pinnedMigration;
  }

  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  try {
    await query(sql);
  } catch (error) {
    console.error('[db] échec application du schéma :', error.message);
    return { applied: false, reason: error.message };
  }

  await query(
    'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
    ['001_initial'],
  );

  // Les travaux d'ingestion vivent en mémoire : un redémarrage du conteneur les
  // interrompt. Les lignes 'pending'/'running' resteraient alors affichées comme
  // « en cours » indéfiniment. On les marque en échec, ce qui supprime aussi
  // leurs fragments partiels, pour que l'interface reparte d'un état sain.
  try {
    const interrupted = await getPool().query(
      `SELECT id, title FROM files WHERE ingest_status IN ('pending', 'running')`,
    );
    for (const row of interrupted.rows) {
      // eslint-disable-next-line no-await-in-loop
      await getPool().query(
        `UPDATE files SET ingest_status = 'error', done_chunks = 0,
            error_detail = $2, finished_at = now() WHERE id = $1`,
        [row.id, 'Indexation interrompue par un redémarrage de l’application'],
      );
      // eslint-disable-next-line no-await-in-loop
      await getPool().query('DELETE FROM chunks WHERE file_id = $1', [row.id]);
    }
    if (interrupted.rows.length > 0) {
      console.warn(`[db] ${interrupted.rows.length} indexation(s) interrompue(s) remise(s) à zéro`);
    }
  } catch (error) {
    // Non bloquant : le chat doit rester utilisable.
    console.warn('[db] nettoyage des indexations interrompues impossible :', error.message);
  }

  console.log('[db] schéma appliqué (version 001_initial)');
  return { applied: true, reason: null };
}

/**
 * Attend que PostgreSQL réponde. Le conteneur postgres et le model-loader
 * démarrant en parallèle, la base n'est pas forcément prête au premier boot.
 */
async function waitForDatabase(timeoutMs = 60000, intervalMs = 2000) {
  const start = Date.now();
  for (;;) {
    const health = await checkConnection();
    if (health.available) {
      console.log('[db] PostgreSQL prêt');
      return true;
    }
    if (Date.now() - start > timeoutMs) {
      console.warn('[db] timeout en attente de PostgreSQL :', health.error);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

module.exports = { applySchema, waitForDatabase, SCHEMA_PATH, getPool };
