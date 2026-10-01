import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Colonne de gauche : espaces de travail et, sous chacun, les conversations.
 *
 * Hiérarchie (comme AnythingLLM) :
 *   espace de travail
 *     ├── chat
 *     └── chat
 *
 * Le bouton « + Nouveau » crée un espace *et* son premier chat : c'est le
 * geste le plus fréquent, il ne doit pas demander deux confirmations. Les
 * conversations sans espace restent accessibles dans un groupe « Sans espace »
 * en bas de liste — on ne perd jamais un chat.
 */
function ChatSidebar({
  workspaces,
  conversations,
  activeId,
  activeWorkspaceId,
  collapsed,
  onToggle,
  onSelect,
  onDelete,
  onDeleteWorkspace,
  onNewWorkspace,
  onNewChat,
  disabled,
}) {
  const listRef = useRef(null);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');

  // Sur un élément déjà sélectionné, on le ramène dans le viewport.
  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const active = listRef.current.querySelector('.is-active');
    if (active?.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [activeId]);

  // Regroupement : un espace ne montre que ses conversations, le groupe
  // « sans espace » ne montre que celles qui n'ont pas de workspace_id.
  const groups = useMemo(() => {
    const byWorkspace = new Map();
    const orphans = [];
    for (const conversation of conversations) {
      const key = conversation.workspace_id || null;
      if (key) {
        if (!byWorkspace.has(key)) byWorkspace.set(key, []);
        byWorkspace.get(key).push(conversation);
      } else {
        orphans.push(conversation);
      }
    }
    return { byWorkspace, orphans };
  }, [conversations]);

  const submitName = async (event) => {
    event.preventDefault();
    const name = draft.trim();
    setNaming(false);
    setDraft('');
    if (!name) return;
    await onNewWorkspace(name);
  };

  const renderConversation = (conversation) => (
    <li
      key={conversation.id}
      className={`chat-history-item${conversation.id === activeId ? ' is-active' : ''}`}
    >
      <button
        type="button"
        className="chat-history-open"
        onClick={() => onSelect(conversation.id)}
        disabled={disabled}
        title={conversation.title}
      >
        <span className="chat-history-name">{conversation.title}</span>
        <span className="chat-history-meta">
          {conversation.message_count} message{Number(conversation.message_count) > 1 ? 's' : ''}
        </span>
      </button>
      <button
        type="button"
        className="chat-history-delete"
        onClick={() => onDelete(conversation.id)}
        disabled={disabled}
        title="Supprimer définitivement cette conversation"
        aria-label={`Supprimer ${conversation.title}`}
      >
        ✕
      </button>
    </li>
  );

  // Saisie du nom : affichée à la place de la liste pendant la création.
  if (naming) {
    return (
      <aside className="chat-sidebar" aria-label="Nouvel espace de travail">
        <form className="chat-sidebar-head" onSubmit={submitName}>
          <input
            className="chat-workspace-name-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Nom de l'espace"
            autoFocus
            maxLength={200}
            aria-label="Nom de l'espace de travail"
          />
          <button type="submit" className="chat-sidebar-new" disabled={!draft.trim() || disabled}>
            Créer
          </button>
          <button
            type="button"
            className="chat-history-delete"
            onClick={() => { setNaming(false); setDraft(''); }}
            title="Annuler"
            aria-label="Annuler la création"
          >
            ✕
          </button>
        </form>
      </aside>
    );
  }

  return (
    <aside
      className={`chat-sidebar${collapsed ? ' is-collapsed' : ''}`}
      aria-label="Espaces de travail et historique des conversations"
    >
      <div className="chat-sidebar-head">
        <button
          type="button"
          className="chat-sidebar-toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          title={collapsed ? 'Afficher l’historique' : 'Masquer l’historique'}
        >
          <span className="chat-sidebar-caret" aria-hidden="true">{collapsed ? '›' : '‹'}</span>
          <span className="chat-sidebar-heading">Espaces</span>
        </button>
        {!collapsed && (
          <button
            type="button"
            className="chat-sidebar-new"
            onClick={() => { setNaming(true); setDraft(''); }}
            disabled={disabled}
            title="Créer un espace de travail avec un premier chat"
          >
            + Nouveau
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="chat-sidebar-scroll" ref={listRef}>
          {workspaces.length === 0 && groups.orphans.length === 0 && (
            <p className="chat-sidebar-subtitle">Aucun espace de travail</p>
          )}

          {workspaces.map((workspace) => {
            const items = groups.byWorkspace.get(workspace.id) || [];
            return (
              <section
                key={workspace.id}
                className={`chat-workspace${activeWorkspaceId === workspace.id ? ' is-active' : ''}`}
              >
                <header className="chat-workspace-head">
                  <span className="chat-workspace-name-text" title={workspace.name}>
                    {workspace.name}
                  </span>
                  <span className="chat-workspace-count">
                    {items.length} chat{items.length > 1 ? 's' : ''}
                  </span>
                  <button
                    type="button"
                    className="chat-history-delete"
                    onClick={() => onDeleteWorkspace(workspace.id)}
                    disabled={disabled}
                    title={`Supprimer l’espace « ${workspace.name} » (les chats sont conservés)`}
                    aria-label={`Supprimer l’espace ${workspace.name}`}
                  >
                    ✕
                  </button>
                </header>
                {items.length === 0 ? (
                  <p className="chat-sidebar-subtitle chat-workspace-empty">Aucun chat</p>
                ) : (
                  <ul className="chat-history-list">{items.map(renderConversation)}</ul>
                )}
                {/* Nouveau chat : placé sous la liste du groupe, comme dans
                    AnythingLLM. On l'ajoute « à la suite » du chat courant. */}
                <button
                  type="button"
                  className="chat-workspace-thread"
                  onClick={() => onNewChat(workspace.id)}
                  disabled={disabled}
                  title={`Ajouter un chat dans « ${workspace.name} »`}
                >
                  <span className="chat-workspace-thread-caret" aria-hidden="true">+</span>
                  Nouveau chat
                </button>
              </section>
            );
          })}

          {groups.orphans.length > 0 && (
            <section className="chat-workspace chat-workspace-orphans">
              <header className="chat-workspace-head">
                <span className="chat-workspace-name-text chat-workspace-name-muted">
                  Sans espace
                </span>
                <span className="chat-workspace-count">
                  {groups.orphans.length} chat{groups.orphans.length > 1 ? 's' : ''}
                </span>
              </header>
              <ul className="chat-history-list">{groups.orphans.map(renderConversation)}</ul>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

export default ChatSidebar;
