import { useCallback, useEffect, useMemo, useState } from 'react';
import FileExplorer from './FileExplorer';
import {
  fetchRagStatus,
  fetchWorkspaces,
  setConversationWorkspace,
} from '../chat/ragClient';
// fetchDbHealth et listConversations vivent dans historyClient : c'est le module
// qui parle de l'historique, pas des fichiers.
import { fetchDbHealth, listConversations } from '../chat/historyClient';
import '../chat/chat.css';
import '../rag/rag.css';
import './documents.css';

/**
 * Page Documents — onglet de plein droit du menu principal.
 *
 * L'explorateur (FileExplorer) porte les dossiers, les fichiers et leur
 * rattachement aux espaces de travail. Cette page ne lui fournit que les
 * limites d'ingestion, et un panneau latéral listant les chats qui ne sont
 * encore rattachés à aucun espace, afin de pouvoir les affecter.
 *
 * L'espace de travail n'est pas sélectionnable ici : le rattachement se fait
 * par le clic droit sur un dossier. La gestion des espaces (création,
 * suppression) reste dans l'onglet Chat.
 */
export default function DocumentsPage() {
  const [persistence, setPersistence] = useState(false);
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('');
  const [conversations, setConversations] = useState([]);
  const [limits, setLimits] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  // fetchDbHealth renvoie { available, error } : c'est `available` qui porte
  // l'état, pas `ok`. Lire `ok` donnait toujours undefined, d'où un bandeau
  // « base indisponible » affiché en permanence alors que tout fonctionnait.
  useEffect(() => {
    fetchDbHealth().then((health) => setPersistence(Boolean(health?.available)));
  }, []);

  const refreshSide = useCallback(async () => {
    const [status, spaces, convs] = await Promise.all([
      fetchRagStatus(),
      fetchWorkspaces(),
      listConversations(200),
    ]);
    if (status.ok) {
      setLimits({
        maxFileBytes: status.maxFileBytes,
        maxDocumentChars: status.maxDocumentChars,
        maxChunks: status.maxChunks,
        supportedExtensions: status.supportedExtensions,
      });
    }
    if (spaces.ok) {
      setWorkspaces(spaces.workspaces);
      setActiveWorkspaceId((current) => {
        if (current && spaces.workspaces.some((w) => w.id === current)) return current;
        return spaces.workspaces[0]?.id || '';
      });
    }
    if (convs.ok) setConversations(convs.conversations || []);
    setLoading(false);
  }, []);

  useEffect(() => { refreshSide(); }, [refreshSide]);

  const attachConversation = useCallback(async (conversationId) => {
    if (!activeWorkspaceId) return;
    await setConversationWorkspace(conversationId, activeWorkspaceId);
    await refreshSide();
  }, [activeWorkspaceId, refreshSide]);

  // Seuls les chats sans espace sont listés : ceux qui sont déjà rattachés
  // n'apparaissent pas dans ce panneau, seul le compteur du menu les récapitule.
  const orphanConversations = useMemo(
    () => conversations.filter((c) => !c.workspace_id),
    [conversations],
  );

  // Sans espace actif, « Rattacher » n'a nulle part où rattacher : le panneau
  // n'aurait alors aucun sens.
  const showOrphans = orphanConversations.length > 0 && Boolean(activeWorkspaceId);

  return (
    <section className="docs-page">
      <header className="docs-page-header">
        <div>
          <h2>Documents</h2>
          <p className="card-subtitle">
            Un dossier contient des fichiers, indexés pour la recherche.
            Clic droit sur un dossier de la colonne de gauche pour le rattacher
            à un espace de travail.
          </p>
        </div>
        {!persistence && (
          <p className="rag-error" role="alert">
            Base de données indisponible : les dossiers et fichiers ne seront pas enregistrés.
          </p>
        )}
      </header>

      {loading ? (
        <p className="rag-hint">Chargement…</p>
      ) : (
        <div className={`docs-page-body${showOrphans ? '' : ' is-full'}`}>
          <FileExplorer limits={limits} busy={busy} onBusyChange={setBusy} />

          {/* Le panneau latéral n'existe que s'il a quelque chose à montrer :
              sans cela il laisserait une colonne vide de 280 px à droite. */}
          {showOrphans && (
            <aside className="docs-page-side">
              <section className="docs-side-section">
                <h4 className="rag-section-title">Chats sans espace</h4>
                <p className="rag-hint">
                  Rattachez-les pour qu’ils utilisent les dossiers de cet espace.
                </p>
                <ul className="docs-side-list">
                  {orphanConversations.map((conversation) => (
                    <li key={conversation.id}>
                      <span className="docs-side-name">{conversation.title}</span>
                      <button type="button" onClick={() => attachConversation(conversation.id)}>
                        Rattacher
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            </aside>
          )}
        </div>
      )}
    </section>
  );
}
