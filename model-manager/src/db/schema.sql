-- Schéma LIA-X — conversations, messages et folders RAG.
--
-- Appliqué par model-manager/src/db/migrate.js au démarrage du conteneur.
-- Idempotent : chaque objet est créé avec IF NOT EXISTS, et un journal
-- schema_migrations trace les versions déjà appliquées.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL DEFAULT 'Nouvelle conversation',
  model         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived      BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS conversations_updated_idx
  ON conversations (updated_at DESC);

-- ---------------------------------------------------------------------------
-- Messages
-- role : 'user' | 'assistant' | 'system'
-- reasoning : flux reasoning_content des modèles à raisonnement, nullable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT NOT NULL DEFAULT '',
  reasoning       TEXT,
  model           TEXT,
  error           TEXT,
  position        INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un index unique sur (conversation_id, position) empêche deux messages d'atterrir
-- au même rang si deux requêtes arrivent en parallèle.
CREATE UNIQUE INDEX IF NOT EXISTS messages_position_idx
  ON messages (conversation_id, position);

CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Dossiers de fichiers.
--
-- parent_id fait de l'arborescence : un dossier peut en contenir d'autres.
-- Il est volontairement NULLABLE : une racine n'a pas de parent, et une
-- contrainte NOT NULL REFERENCES n'aurait pas de valeur par défaut à donner.
-- ON DELETE CASCADE évite qu'un dossier supprimé laisse des sous-dossiers
-- orphelins.
--
-- Le nom n'est plus unique au sens global : c'était incompatible avec une
-- arborescence, puisque deux sous-dossiers « Notes » dans deux dossiers
-- différents doivent pouvoir coexister. L'unicité est vérifiée côté
-- application, sur le couple (parent, nom), ce qui donne un message d'erreur
-- lisible au lieu d'un code HTTP 409 opaque.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  parent_id   UUID REFERENCES folders(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index de la colonne de gauche : l'arborescence se parcourt par parent_id.
CREATE INDEX IF NOT EXISTS folders_parent_idx ON folders (parent_id);
CREATE INDEX IF NOT EXISTS folders_name_idx ON folders (lower(name));

CREATE TABLE IF NOT EXISTS files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  source_path   TEXT,
  title         TEXT,
  content_hash  TEXT,
  -- Taille du fichier source en octets. Alimente la colonne « Taille » de
  -- l'explorateur ; absente avant, la requête COALESCE alors à 0.
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- L'explorateur affiche « Modifié le ». Un fichier est normalement modifié à
  -- son ingest, donc une simple copie de created_at ; la colonne existe pour
  -- qu'une réindexation ou un renommage puisse être daté plus tard sans
  -- migration.
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Suivi de l'indexation. L'ingestion est asynchrone : le file est créé
  -- immédiatement pour que l'interface puisse afficher la progression, puis ses
  -- fragments sont calculés et insérés en tâche de fond.
  --   'pending'  fichier reçu, indexation pas commencée
  --   'running'  extraction ou calcul des vecteurs en cours
  --   'ready'    indexé, visible dans la recherche
  --   'error'    échec : le champ error_detail explique la cause
  ingest_status TEXT NOT NULL DEFAULT 'ready',
  total_chunks  INTEGER NOT NULL DEFAULT 0,
  done_chunks   INTEGER NOT NULL DEFAULT 0,
  error_detail  TEXT,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

-- L'index sur l'ingestion en cours est créé par la migration 002 : il référence
-- la colonne ingest_status, qui n'existe pas encore dans une base déjà créée.
-- Le créer ici ferait échouer tout schema.sql sur une installation antérieure.

-- Espaces de travail.
--
-- Un espace regroupe plusieurs conversations et pointe vers une ou plusieurs
-- folders de files. La conversation n'a plus à répéter la sélection :
-- on rattache les files une fois, au niveau de l'espace.
--
-- ON DELETE SET NULL sur conversations.workspace_id : supprimer un espace ne
-- doit pas supprimer les conversations qu'il contenait, elles restent
-- accessibles depuis l'historique.
CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_folders (
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, folder_id)
);

CREATE INDEX IF NOT EXISTS workspace_folders_folder_idx
  ON workspace_folders (folder_id);

-- La colonne est ajoutée par la migration 004 sur les bases existantes ; elle
-- figure ici pour les installations neuves.

-- Sélection de folders par conversation.
--
-- Avant, les folders cochées dans l'interface s'appliquaient à toutes les
-- conversations. Chaque conversation porte désormais sa propre sélection, sinon
-- documenter un projet A polluait la recherche du projet B.
--
-- Table de jonction et non colonne : une conversation peut viser plusieurs
-- dossiers à la fois. Les deux ON DELETE CASCADE garantissent qu'il ne reste
-- jamais de lien orphelin après la suppression d'une conversation ou d'un
-- dossier.
CREATE TABLE IF NOT EXISTS conversation_folders (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  folder_id   UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, folder_id)
);

-- Index inverse : lors de la suppression d'un dossier, PostgreSQL trouve
-- ainsi les lignes de jonction à effacer sans parcourir toute la table.
CREATE INDEX IF NOT EXISTS conversation_folders_folder_idx
  ON conversation_folders (folder_id);

-- Dimension du modèle d'embeddings au premier démarrage (nomic-embed-text-v2-moe
-- produit 768 valeurs). pgvector fige la dimension dans le TYPE de la colonne :
-- ce 768 n'est qu'une valeur initiale. Changer de modèle (qwen3-embedding-0.6b
-- = 1024, etc.) est désormais pris en charge automatiquement : à la première
-- ingestion, l'application lit la dimension réelle du vecteur produit, compare
-- avec la colonne, et exécute ALTER TABLE ... TYPE vector(N) si elles diffèrent
-- (cf. ensureVectorDimensions / migrateEmbeddingDimension). Les fragments de
-- l'ancienne dimension sont purgés : leurs similarités ne sont plus calculables.
-- Aucune intervention manuelle n'est donc requise de la part de l'utilisateur.
CREATE TABLE IF NOT EXISTS chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id   UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  content       TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 768 valeurs par défaut, modifiable via ALTER TABLE quand le modèle change.
  embedding     vector(768),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_id, ordinal)
);

-- Index HNSW pour la recherche vectorielle par similarité cosinus.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS chunks_file_idx
  ON chunks (file_id);
