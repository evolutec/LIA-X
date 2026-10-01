import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChatComposer from './ChatComposer';
import ChatMessage from './ChatMessage';
import useAutoSpeak from './useAutoSpeak';
import useVoiceConversation from './useVoiceConversation';
import ChatModelSelector from './ChatModelSelector';
import ChatSidebar from './ChatSidebar';
import { getRuntimeState, listModels, streamChat } from './chatClient';
import {
  createConversation,
  deleteConversation,
  deleteMessage,
  fetchDbHealth,
  fetchConversation,
  listConversations,
  renameConversation,
  saveMessage,
} from './historyClient';
import {
  createFolder,
  createWorkspace,
  deleteFolder,
  deleteDocument,
  deleteWorkspace,
  fetchConversationFolders,
  fetchRagStatus,
  fetchWorkspace,
  fetchWorkspaces,
  ingestDocument,
  listDocuments,
  saveConversationFolders,
  saveWorkspaceFolders,
  setConversationWorkspace,
  searchPassages,
} from './ragClient';
import './chat.css';

// Repli de la colonne mémorisé : la largeur de travail est une préférence
// utilisateur, pas un état de session.
const SIDEBAR_STORAGE_KEY = 'liax.chat.sidebar.collapsed';

function readSidebarPreference() {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

// Dernière conversation ouverte : permet de la retrouver au rechargement,
// comme le ferait un client de messagerie.
const ACTIVE_CONVERSATION_KEY = 'liax.chat.active.conversation';

function readRememberedConversation() {
  try {
    return window.localStorage.getItem(ACTIVE_CONVERSATION_KEY) || '';
  } catch {
    return '';
  }
}

function rememberConversation(id) {
  try {
    if (id) window.localStorage.setItem(ACTIVE_CONVERSATION_KEY, id);
    else window.localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
  } catch {
    // Stockage indisponible : la conversation ouverte n'est simplement pas
    // restaurée au prochain rechargement.
  }
}

/**
 * Page Chat.
 *
 * Phase 1 : conversation en streaming contre /v1/chat/completions, dont le
 * proxy assure l'autochargement du modèle et le routage multi-instances.
 * L'historique est persisté côté PostgreSQL dès qu'un message est envoyé. Si la
 * base est injoignable, l'interface bascule en mode mémoire et l'annonce : on ne
 * perd pas la conversation en cours, seul le rechargement la fera disparaître.
 */
function ChatPage() {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [runtime, setRuntime] = useState({ loading: true, activeModel: '', error: '' });
  // persistence=false => mode mémoire : l'historique ne survivra pas au rechargement.
  const [persistence, setPersistence] = useState(true);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  // Modèle choisi pour CETTE conversation. Vide = modèle principal du runtime.
  const [selectedModel, setSelectedModel] = useState('');
  const [models, setModels] = useState([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarPreference);
  // --- RAG ---
  const [ragOpen, setRagOpen] = useState(false);
  // Onglet actif de la colonne de droite : chat ou files.
  const [folders, setFolders] = useState([]);
  const [files, setDocuments] = useState([]);
  const [activeFolders, setActiveFolders] = useState([]);
  const [ragBusy, setRagBusy] = useState(false);
  // Espaces de travail.
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('');
  const [workspaceFolders, setWorkspaceFolders] = useState([]);
  // Limites et formats acceptés, fournis par /api/rag/status.
  const [ragLimits, setRagLimits] = useState(null);
  // Passages utilisés pour la dernière réponse, affichés sous le message.
  const [lastPassages, setLastPassages] = useState([]);
  const abortRef = useRef(null);
  // Suivi du réveil : `active` tant qu'aucun token n'est arrivé, `startedAt`
  // pour l chrono. On garde l'heure de départ dans une ref et non dans l'état
  // pour éviter de re-rendre à chaque tick.
  const wakeRef = useRef({ active: false, startedAt: 0 });
  const [wakeSeconds, setWakeSeconds] = useState(0);
  const scrollRef = useRef(null);
  const bottomRef = useRef(null);

  // Lecture automatique des réponses, si elle est activée dans les paramètres.
  // Le crochet n'a besoin que de la liste des messages : toute la logique
  // (une seule lecture par message, arrêt au démontage) vit dans useAutoSpeak.
  useAutoSpeak(messages);

  const activeModel = runtime.activeModel || 'Aucun modèle chargé';

  // État de la base + liste des conversations au montage.
  useEffect(() => {
    let cancelled = false;
    fetchDbHealth().then((health) => {
      if (!cancelled) setPersistence(health.available);
    });
    listConversations().then((result) => {
      if (cancelled || !result.ok) return;
      setConversations(result.conversations);
      // Restaure la conversation ouverte (avec son modèle épinglé) plutôt que
      // d'afficher un écran vide alors que l'historique est disponible.
      const remembered = readRememberedConversation();
      const match = remembered
        ? result.conversations.find((c) => c.id === remembered)
        : result.conversations[0];
      if (match) openConversation(match.id);
    });
    return () => { cancelled = true; };
    // openConversation est volontairement hors dépendances : il change à chaque
    // render (il dépend de `messages`), et le remettre ici créerait une boucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Modèles chargés : la liste change quand l'utilisateur charge ou arrête une
  // instance dans l'onglet Accueil, donc on la rafraîchit à intervalle régulier.
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const list = await listModels();
        if (!cancelled) setModels(list);
      } catch {
        // Le runtime peut redémarrer : on garde la liste précédente.
      }
    }
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // Stockage indisponible (mode privé) : le repli reste valable pour la session.
      }
      return next;
    });
  }, []);

  // Rafraîchit la liste après chaque échange pour garder le compteur à jour.
  const refreshConversations = useCallback(() => {
    if (!persistence) return;
    listConversations().then((result) => {
      if (result.ok) setConversations(result.conversations);
    });
  }, [persistence]);

  // Ouvre une conversation existante et restaure son modèle.
  const openConversation = useCallback(async (id) => {
    if (streaming) return;
    const result = await fetchConversation(id);
    if (!result.ok) return;
    setConversationId(result.conversation.id);
    rememberConversation(result.conversation.id);
    setSelectedModel(result.conversation.model || '');
    setMessages(result.conversation.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      reasoning: m.reasoning || '',
      model: m.model || '',
      error: m.error || '',
      streaming: false,
    })));

    // Restaure la sélection de dossiers propre à cette conversation.
    if (persistence) {
      const selected = await fetchConversationFolders(result.conversation.id);
      if (selected.ok) setActiveFolders(selected.folderIds);
    }

    // L'espace courant suit la conversation ouverte : c'est lui qui détermine
    // quelles dossiers sont proposées dans la barre RAG.
    const owner = result.conversation.workspace_id || '';
    if (owner) {
      setActiveWorkspaceId(owner);
      const detail = await fetchWorkspace(owner);
      if (detail.ok) {
        setWorkspaceFolders((detail.folders || []).map((c) => c.id));
      }
    }
  }, [streaming, persistence]);

  // Crée la ligne en base à la volée, sans bloquer l'affichage.
  const ensureConversation = useCallback(async () => {
    if (conversationId) return conversationId;
    if (!persistence) return null;
    const result = await createConversation({ model: selectedModel || activeModel });
    if (result.ok && result.conversation) {
      setConversationId(result.conversation.id);
      rememberConversation(result.conversation.id);
      return result.conversation.id;
    }
    return null;
  }, [conversationId, persistence, selectedModel, activeModel]);

  // Changement de modèle : appliqué à la conversation courante, et persisté si
  // elle existe déjà.
  //
  // Les messages déjà affichés ne sont PAS modifiés : une réponse produite par
  // Qwopus reste une réponse de Qwopus, même après avoir changé de modèle pour
  // la suite. Réécrire leurs libellés en mémoire affichait un modèle faux, et le
  // rechargement rétablissait la bonne valeur — d'où une incohérence visible.
  // Seul le modèle des nouveaux messages est celui de la conversation.
  const changeModel = useCallback((modelId) => {
    setSelectedModel(modelId);
    if (persistence && conversationId && modelId) {
      renameConversation(conversationId, undefined, modelId);
      refreshConversations();
    }
  }, [persistence, conversationId, refreshConversations]);

  useEffect(() => {
    let cancelled = false;
    getRuntimeState()
      .then((state) => {
        if (cancelled) return;
        setRuntime({
          loading: false,
          activeModel: state?.runtime?.active_model || '',
          error: '',
          // Filenames des instances residentes : un modèle y figure s il est
          // épinglé (sleep_idle_seconds < 0), donc jamais déchargé.
          resident: new Set((state?.runtime?.instances || [])
            .filter((instance) => Number(instance.sleep_idle_seconds) < 0)
            .map((instance) => instance.filename))
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setRuntime({ loading: false, activeModel: '', error: error.message });
      });
    return () => { cancelled = true; };
  }, []);

  // Follow automatique : on colle en bas tant que l'utilisateur est déjà près
  // du bas (sinon on ne le ferait pas défiler sous ses yeux).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 160;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }
  }, [messages]);

  // Le réveil n'est signalé qu'après WAKE_HINT_DELAY_S : en dessous, c'est
  // juste la latence normale du réseau et un message clignotant serait du bruit.
  const WAKE_HINT_DELAY_S = 1.5;
  // Au-delà de ce seuil, on précise que le chargement peut être long : c'est
  // le moment où l'utilisateur commence à croire à un blocage.
  const WAKE_LONG_HINT_S = 15;

  // Masque l'indicateur dès qu'un token arrive ou que le flux se termine.
  const markAwake = useCallback(() => {
    wakeRef.current.active = false;
    setWakeSeconds(0);
  }, []);

  // Compteur du réveil. Tourne tant qu'aucun token n'est pas arrivé, puis
  // s'arrête tout seul : aucun nettoyage manuel à faire côté appelant.
  useEffect(() => {
    if (!streaming) return undefined;
    const timer = window.setInterval(() => {
      if (!wakeRef.current.active) return;
      setWakeSeconds((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  // Un modèle épinglé reste chargé en VRAM en permanence (sleep_idle_seconds
  // négatif côté contrôleur) : il n'a jamais à être réveillé, et afficher
  // « Réveil en cours » serait mensonger. On masque donc l'indicateur.
  const targetFilename = `${selectedModel || runtime.activeModel || ''}.gguf`;
  const targetIsResident = Boolean(runtime.resident && runtime.resident.has(targetFilename));
  const showWakeHint = streaming
    && wakeRef.current.active
    && wakeSeconds >= WAKE_HINT_DELAY_S
    && !targetIsResident;

  const send = useCallback(async (text) => {
    if (streaming) return;

    // Modèle visé pour ce tour : celui choisi dans la conversation, sinon le
    // modèle principal du runtime (chaîne vide => routage par défaut du proxy).
    const targetModel = selectedModel || '';

    const userMessage = { id: `u-${Date.now()}`, role: 'user', content: text };
    const assistantId = `a-${Date.now()}`;

    setMessages((prev) => [
      ...prev,
      userMessage,
      { id: assistantId, role: 'assistant', content: '', reasoning: '', streaming: true, model: targetModel || activeModel },
    ]);
    setStreaming(true);
    // Réveil : le premier token peut tarder quand les poids du modèle ont été
    // évacués de la mémoire par le système. Sans signal, l'interface semble
    // figée et l'utilisateur appuie sur « Arrêter » — ce qui abandonne la
    // requête alors que le chargement, lui, continue côté serveur.
    wakeRef.current = { startedAt: Date.now(), active: true, seenToken: false };
    setWakeSeconds(0);

    // L'historique envoyé exclut le message assistant vide qu'on vient d'ajouter.
    const history = [...messages, userMessage]
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
      .map((m) => ({ role: m.role, content: m.content }));

    // Recherche RAG : on interroge la base AVANT d'appeler le modèle, puis on
    // place les passages trouvés dans un message système. Si la recherche échoue
    // (modèle d'embeddings indisponible), on continue sans contexte : mieux vaut
    // une réponse sans file qu'une conversation bloquée.
    let systemMessage = null;
    if (persistence && activeFolders.length > 0) {
      const found = await searchPassages(text, {
        folderIds: activeFolders,
        limit: 4,
        minSimilarity: 0.3,
      });
      if (found.ok && found.passages.length > 0) {
        setLastPassages(found.passages);
        const context = found.context
          || found.passages.map((p, i) => `[${i + 1}] ${p.title}\n${p.content}`).join('\n');
        systemMessage = {
          role: 'system',
          content: [
            'Tu es l’assistant de LIA-X, un assistant local fonctionnant hors ligne.',
            '',
            'Des extraits de files de référence t’ont été fournis. Utilise-les pour répondre '
            + 'précisément quand ils sont pertinents.',
            'Règles :',
            '- Cite la source entre crochets, par exemple [1], quand tu t’appuies sur un extrait.',
            '- Si les extraits ne suffisent pas, dis-le et réponds avec tes connaissances générales '
            + 'sans inventer de source.',
            '',
            context,
          ].join('\n'),
        };
      } else {
        setLastPassages([]);
      }
    } else {
      setLastPassages([]);
    }

    if (systemMessage) {
      // Le message système va en tête : il décrit le cadre avant l'historique.
      history.unshift(systemMessage);
    }

    const controller = new AbortController();
    abortRef.current = controller;

    // La ligne de conversation est créée au premier message : pas de ligne vide
    // dans l'historique si l'utilisateur ouvre le chat puis repart sans parler.
    const targetConversationId = await ensureConversation();
    if (persistence && targetConversationId) {
      saveMessage(targetConversationId, { role: 'user', content: text }).then(() => refreshConversations());
    }

    await streamChat(
      '/v1/chat/completions',
      { model: targetModel, messages: history },
      {
        onDelta: (_delta, accumulated) => {
          // Le premier token arrive : le modèle est réveillé, on masque l'indicateur.
          markAwake();
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m)));
        },
        onReasoning: (_chunk, accumulatedReasoning) => {
          // Le raisonnement compte comme un token : le modèle répond déjà.
          markAwake();
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, reasoning: accumulatedReasoning } : m)));
        },
        onDone: (result) => {
          markAwake();
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
          // On n'écrit la réponse en base qu'une fois terminée et non interruptible :
          // enregistrer chaque token produirait une ligne par fragment.
          if (persistence && targetConversationId && !result?.aborted && result?.content) {
            saveMessage(targetConversationId, {
              role: 'assistant',
              content: result.content,
              reasoning: result.reasoning || '',
              model: targetModel || activeModel,
            }).then(() => refreshConversations());
          }
        },
        onError: (error) => {
          markAwake();
          setMessages((prev) => prev.map((m) => (
            m.id === assistantId ? { ...m, streaming: false, error: error.message } : m
          )));
          if (persistence && targetConversationId) {
            saveMessage(targetConversationId, {
              role: 'assistant',
              content: '',
              model: targetModel || activeModel,
              error: error.message,
            }).then(() => refreshConversations());
          }
        },
      },
      controller.signal,
    );

    abortRef.current = null;
    setStreaming(false);
    markAwake();
  }, [messages, streaming, activeModel, selectedModel, persistence, ensureConversation, refreshConversations, activeFolders, markAwake]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    markAwake();
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  }, [markAwake]);

  // ── Mode dialogue vocal ──────────────────────────────────────────────────
  // Placé après `send`/`stop` : le crochet reçoit ces deux callbacks, et les
  // référencer avant leur initialisation lèverait une erreur de portée.
  //
  // Le texte lu au fil de l'eau est celui du dernier message de l'assistant
  // tant qu'il est en cours de génération : c'est ce flux que la voix consomme
  // progressivement, phrase par phrase.
  const streamingText = useMemo(() => {
    const last = messages[messages.length - 1];
    // Texte du dernier message de l'assistant, generation terminée ou non : le
    // mode vocal a besoin du contenu final pour prononcer les derniers mots
    // quand la generation s'acheve.
    if (!last || last.role !== 'assistant') return '';
    return last.content || '';
  }, [messages]);

  const voice = useVoiceConversation({
    onSend: send,
    onStop: stop,
    streaming,
    text: streamingText,
  });

  const retry = useCallback((messageId) => {
    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 1) return;
    const previousUser = messages[index - 1];
    if (!previousUser || previousUser.role !== 'user') return;
    setMessages(messages.slice(0, index - 1));
    // Délai : l'état doit être commité avant l'envoi, sinon `messages`
    // contiendrait encore l'ancienne réponse dans l'historique transmis.
    setTimeout(() => { send(previousUser.content); }, 0);
  }, [messages, send]);

  // « Nouvelle conversation » : on ne supprime PAS la ligne en base, on passe
  // simplement à une conversation vierge. L'historique reste consultable.
  const clear = useCallback(() => {
    if (streaming) stop();
    setMessages([]);
    setConversationId(null);
    setSelectedModel('');
    // Une conversation vierge n'hérite pas des dossiers de la précédente :
    // sinon un nouveau sujet repartirait avec les files de l'ancien.
    setActiveFolders([]);
    rememberConversation(null);
  }, [streaming, stop]);

  // Suppression définitive depuis la liste de l'historique.
  const removeConversation = useCallback(async (id) => {
    if (streaming) return;
    const result = await deleteConversation(id);
    if (!result.ok) return;
    if (id === conversationId) {
      setMessages([]);
      setConversationId(null);
      setSelectedModel('');
      setActiveFolders([]);
      rememberConversation(null);
    }
    refreshConversations();
  }, [streaming, conversationId, refreshConversations]);

  const hasMessages = messages.length > 0;

  // --- RAG : chargement des dossiers et files ---
  const refreshRag = useCallback(async () => {
    const status = await fetchRagStatus();
    if (status.ok) {
      setFolders(status.folders || []);
      setRagLimits({
        maxFileBytes: status.maxFileBytes,
        maxDocumentChars: status.maxDocumentChars,
        maxChunks: status.maxChunks,
        supportedExtensions: status.supportedExtensions,
      });
    }
    const docs = await listDocuments(null);
    if (docs.ok) setDocuments(docs.files);

    const spaces = await fetchWorkspaces();
    if (spaces.ok) {
      setWorkspaces(spaces.workspaces);
      // À la première ouverture, on présélectionne le premier espace : sans
      // cela, l'onglet Files afficherait des champs vides alors que des
      // espaces existent déjà.
      setActiveWorkspaceId((current) => {
        if (current && spaces.workspaces.some((w) => w.id === current)) return current;
        return spaces.workspaces[0]?.id || '';
      });
    }
  }, []);

  // Crée un espace de travail, puis un premier chat à l'intérieur. L'espace
  // est l'unité de rangement : il porte les dossiers de files que l'on
  // lui rattache depuis la page Files, et tous ses chats en profitent.
  //
  // Déclaré après refreshRag volontairement : le référencer dans le tableau de
  // dépendances avant sa déclaration lèverait une ReferenceError dès le premier
  // rendu et viderait toute la page, shell compris.
  const createWorkspaceWithChat = useCallback(async (name) => {
    if (streaming) return;
    const created = await createWorkspace(name);
    if (!created.ok) return;
    const workspaceId = created.workspace.id;
    setActiveWorkspaceId(workspaceId);
    await refreshRag();

    // Premier chat de l'espace : créé en base seulement si la persistance est
    // active, sinon il apparaîtra à l'envoi du premier message.
    if (persistence) {
      // createConversation renvoie un ENVELOPPE { ok, conversation, error } :
      // l'identifiant est dans conversation.conversation.id. Utiliser
      // conversation.id renvoyait « undefined » et le rattachement partait sur
      // PUT /api/conversations/undefined/workspace.
      const created = await createConversation({
        title: 'Nouvelle conversation',
        model: selectedModel || undefined,
      });
      if (created.ok && created.conversation?.id) {
        await setConversationWorkspace(created.conversation.id, workspaceId);
        setConversationId(created.conversation.id);
        rememberConversation(created.conversation.id);
        const list = await listConversations();
        if (list.ok) setConversations(list.conversations);
      }
    }
    setMessages([]);
    setActiveFolders([]);
  }, [streaming, persistence, refreshRag, selectedModel]);

  // Ajoute un chat dans un espace existant (« ＋ » à droite de chaque espace)
  // sans changer les dossiers déjà rattachées à cet espace.
  const addChatToWorkspace = useCallback(async (workspaceId) => {
    if (streaming) return;
    setActiveWorkspaceId(workspaceId);
    setMessages([]);
    setActiveFolders([]);
    if (!persistence) {
      setConversationId(null);
      rememberConversation(null);
      return;
    }
    // Même enveloppe que ci-dessus : l'id est dans created.conversation.id.
    const created = await createConversation({
      title: 'Nouvelle conversation',
      model: selectedModel || undefined,
    });
    if (!created.ok || !created.conversation?.id) return;
    await setConversationWorkspace(created.conversation.id, workspaceId);
    setConversationId(created.conversation.id);
    rememberConversation(created.conversation.id);
    const list = await listConversations();
    if (list.ok) setConversations(list.conversations);
  }, [streaming, persistence, selectedModel]);


  useEffect(() => {
    if (!persistence) return;
    refreshRag();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistence]);

  // Suppression d'un message.
  //
  // Elle doit être persistée : la route DELETE /api/messages/:id existe déjà
  // côté serveur. Sans cet appel, le message disparaissait de l'écran puis
  // réapparaissait au rechargement, puisque rien n'avait été effacé en base.
  // On filtre d'abord localement pour un retour immédiat, puis on persiste ; en
  // cas d'échec, on recharge l'état réel pour ne pas laisser l'interface mentir.
  const removeMessage = useCallback(async (messageId) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    if (!persistence) return;

    const result = await deleteMessage(messageId);
    if (!result.ok && conversationId) {
      // Restaure l'affichage depuis la base : le message y est toujours présent.
      await openConversation(conversationId);
    }
  }, [persistence, conversationId, openConversation]);

  // Tant qu'un file est en cours d'indexation, on rafraîchit la liste pour
  // afficher la progression. Le rafraîchissement s'arrête tout seul dès que plus
  // rien n'est en cours : pas de requête permanente en arrière-plan.
  const hasPending = files.some(
    (file) => file.ingest_status === 'pending' || file.ingest_status === 'running',
  );
  useEffect(() => {
    if (!persistence || !hasPending) return undefined;
    const timer = setInterval(() => { refreshRag(); }, 2000);
    return () => clearInterval(timer);
  }, [persistence, hasPending, refreshRag]);

  const handleCreateFolder = useCallback(async (name) => {
    const result = await createFolder(name);
    if (!result.ok) return;
    await refreshRag();
    // Un dossier fraîchement créé est rattaché à l'espace courant :
    // l'utilisateur vient de la créer pour s'en servir, et l'oublier
    // immédiatement serait source de confusion.
    if (activeWorkspaceId) {
      const next = [...workspaceFolders, result.folder.id];
      setWorkspaceFolders(next);
      saveWorkspaceFolders(activeWorkspaceId, next);
    }
  }, [refreshRag, activeWorkspaceId, workspaceFolders]);

  const handleDeleteFolder = useCallback(async (id) => {
    const result = await deleteFolder(id);
    if (!result.ok) return;
    setActiveFolders((prev) => prev.filter((value) => value !== id));
    await refreshRag();
  }, [refreshRag]);

  const handleIngest = useCallback(async (payload) => {
    setRagBusy(true);
    try {
      const result = await ingestDocument(payload);
      if (result.ok) await refreshRag();
      return result;
    } finally {
      setRagBusy(false);
    }
  }, [refreshRag]);

  // Charge les dossiers de l'espace sélectionné dès qu'il change : sans cet
  // effet, les cases à cocher de l'onglet Files seraient vides alors que
  // l'espace a bien des dossiers rattachées.
  useEffect(() => {
    if (!activeWorkspaceId) {
      setWorkspaceFolders([]);
      return undefined;
    }
    let cancelled = false;
    fetchWorkspace(activeWorkspaceId).then((detail) => {
      if (cancelled || !detail.ok) return;
      setWorkspaceFolders((detail.folders || []).map((folder) => folder.id));
    });
    return () => { cancelled = true; };
  }, [activeWorkspaceId]);

  // Recharge la sélection de dossiers effective depuis le serveur.
  //
  // C'est la seule source de vérité : le serveur y fait l'union des dossiers
  // de l'espace et de la sélection propre à la conversation. Maintenir un
  // second tableau en parallèle le faisait diverger — rattacher un dossier
  // depuis l'Explorateur ne touchait que l'espace, alors que la recherche
  // lisait `activeFolders`, resté figé sur l'ancienne valeur.
  const syncActiveFolders = useCallback(async (target = conversationId) => {
    if (!persistence || !target) {
      setActiveFolders([]);
      return;
    }
    const selected = await fetchConversationFolders(target);
    if (selected.ok) setActiveFolders(selected.folderIds);
  }, [persistence, conversationId]);

  const handleDeleteDocument = useCallback(async (id) => {
    const result = await deleteDocument(id);
    if (result.ok) await refreshRag();
  }, [refreshRag]);

  // --- Espaces de travail ---

  const handleCreateWorkspace = useCallback(async (name) => {
    const result = await createWorkspace(name);
    if (result.ok) {
      await refreshRag();
      // Le nouvel espace est sélectionné et rattaché à la conversation en cours :
      // l'utilisateur vient de le créer pour s'en servir immédiatement.
      setActiveWorkspaceId(result.workspace.id);
      if (persistence && conversationId) {
        setConversationWorkspace(conversationId, result.workspace.id);
      }
    }
  }, [refreshRag, persistence, conversationId]);

  const handleDeleteWorkspace = useCallback(async (id) => {
    const result = await deleteWorkspace(id);
    if (!result.ok) return;
    setActiveWorkspaceId((current) => (current === id ? '' : current));
    await refreshRag();
  }, [refreshRag]);

  // Sélection d'un espace : on charge ses dossiers, et on y rattache la
  // conversation courante pour qu'elle en hérite.
  const selectWorkspace = useCallback(async (id) => {
    setActiveWorkspaceId(id);
    const detail = await fetchWorkspace(id);
    if (detail.ok) {
      setWorkspaceFolders((detail.folders || []).map((folder) => folder.id));
    }
    if (persistence && conversationId) {
      await setConversationWorkspace(conversationId, id);
      // Le rattachement vient de changer : la recherche doit le voir tout de
      // suite, sans attendre l'ouverture d'une autre conversation.
      await syncActiveFolders(conversationId);
    }
  }, [persistence, conversationId, syncActiveFolders]);

  const toggleWorkspaceFolder = useCallback(async (folderId) => {
    if (!activeWorkspaceId) return;
    // Le calcul se fait hors du setState : saveWorkspaceFolders a besoin de la
    // valeur finale, et l'appel à l'intérieur du updater serait exécuté deux
    // fois en mode strict.
    let next = [];
    setWorkspaceFolders((prev) => {
      next = prev.includes(folderId)
        ? prev.filter((value) => value !== folderId)
        : [...prev, folderId];
      return next;
    });
    await saveWorkspaceFolders(activeWorkspaceId, next);
    // Idem : cocher une case change les dossiers effectifs de la recherche.
    await syncActiveFolders();
  }, [activeWorkspaceId, syncActiveFolders]);

  // Nombre de fragments indexés dans les dossiers cochés : affiché en badge.
  const activeChunkCount = useMemo(() => folders
    .filter((folder) => activeFolders.includes(folder.id))
    .reduce((total, folder) => total + Number(folder.chunk_count || 0), 0), [folders, activeFolders]);

  // Noms des dossiers réellement utilisés. Le compteur de dossiers n'apprenait
  // rien à l'utilisateur : « 1 folder » ne disait pas lequel. Au-delà de deux,
  // on résume — la barre n'a pas la place d'une longue liste.
  const activeFolderLabel = useMemo(() => {
    const names = folders
      .filter((folder) => activeFolders.includes(folder.id))
      .map((folder) => `« ${folder.name} »`);
    if (names.length === 0) return '';
    if (names.length <= 2) return names.join(', ');
    return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  }, [folders, activeFolders]);

  return (
    <section className={`chat-layout${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}>
      <ChatSidebar
        workspaces={workspaces}
        conversations={conversations}
        activeId={conversationId}
        activeWorkspaceId={activeWorkspaceId}
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
        onSelect={openConversation}
        onDelete={removeConversation}
        onDeleteWorkspace={handleDeleteWorkspace}
        onNewWorkspace={createWorkspaceWithChat}
        onNewChat={addChatToWorkspace}
        disabled={streaming}
      />

      <div className="chat-page">
        <header className="chat-header">
          <div className="chat-header-title">
            <h2>Chat</h2>
            <ChatModelSelector
              models={models}
              value={selectedModel}
              activeModel={activeModel}
              onChange={changeModel}
              disabled={streaming || runtime.error}
            />
          </div>
          {hasMessages && (
            <div className="chat-header-actions">
              <button type="button" onClick={clear} disabled={streaming}>
                Nouvelle conversation
              </button>
            </div>
          )}
        </header>

        <div className="chat-rag-bar">
          {activeFolders.length > 0 ? (
            <span className="chat-rag-toggle is-on" title={`Dossiers utilisés par cette conversation : ${activeFolderLabel}`}>
              📚 Files
              <span className="chat-rag-badge">
                {activeFolderLabel}
                {activeChunkCount > 0 && ` · ${activeChunkCount} frag.`}
              </span>
            </span>
          ) : (
            <span className="rag-hint">
              Aucun dossier utilisé. Ouvrez l’onglet Documents pour rattacher des
              dossiers à un espace de travail.
            </span>
          )}
        </div>

        {lastPassages.length > 0 && (
          <details className="chat-sources" open={false}>
            <summary>
              {lastPassages.length} source{lastPassages.length > 1 ? 's' : ''} utilisée
              {lastPassages.length > 1 ? 's' : ''}
            </summary>
            <ul>
              {lastPassages.map((passage) => (
                <li key={passage.chunkId}>
                  <span className="chat-source-title">{passage.title}</span>
                  <span className="chat-source-similarity">
                    {Math.round(passage.similarity * 100)} %
                  </span>
                  <p>{passage.content.slice(0, 260)}{passage.content.length > 260 ? '…' : ''}</p>
                </li>
              ))}
            </ul>
          </details>
        )}

        {!runtime.loading && !runtime.error && selectedModel && selectedModel !== activeModel && (
          <p className="chat-hint">
            Conversation épinglée sur <strong>{selectedModel}</strong> (modèle principal : {activeModel}).
          </p>
        )}

        {!persistence && (
          <p className="chat-warning" role="status">
            Base de données indisponible : l’historique n’est conservé que pour cette session et sera
            perdu au rechargement de la page.
          </p>
        )}

        {!hasMessages && (
          <div className="chat-empty">
            <p className="chat-empty-title">Nouvelle conversation</p>
            <p className="chat-empty-text">
              Modèle : <strong>{selectedModel || activeModel}</strong>.
              {runtime.error
                ? ' Le runtime ne répond pas : vérifiez le service LIA Controller.'
                : ' Si aucun modèle n’est chargé, le runtime le chargera automatiquement à la première question.'}
            </p>
          </div>
        )}

        {runtime.error && (
          <p className="chat-runtime-error" role="alert">{runtime.error}</p>
        )}

        <div className="chat-scroll" ref={scrollRef}>
          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              onRetry={message.role === 'assistant' && !message.streaming && !message.error
                ? () => retry(message.id)
                : undefined}
              onDelete={() => removeMessage(message.id)}
            />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Réveil : affiché seulement après le délai de latence normale, et
            seulement tant qu'aucun token n'est arrivé. */}
        {showWakeHint && (
          <p className="chat-wake" role="status">
            <span className="chat-wake-spinner" aria-hidden="true" />
            Réveil du modèle… {wakeSeconds} s
            {wakeSeconds >= WAKE_LONG_HINT_S && (
              <span className="chat-wake-hint">
                {' '}Chargement depuis le disque, cela peut prendre une minute.
              </span>
            )}
          </p>
        )}

        <footer className="chat-footer">
          {hasMessages && (
            <p className="chat-hint">
              {persistence
                ? 'Les messages sont enregistrés au fur et à mesure dans l’historique local.'
                : 'Mode mémoire : cette conversation sera perdue au rechargement de la page.'}
            </p>
          )}
          <div className={`chat-voice-mode${voice.active ? ' is-active' : ''}`}>
            <button
              type="button"
              className="chat-voice-toggle"
              onClick={voice.toggle}
              disabled={!voice.supported}
              aria-pressed={voice.active}
              title={voice.active
                ? 'Quitter le mode dialogue vocal'
                : 'Parler au modèle sans utiliser les mains'}
            >
              {voice.active ? '◉ Dialogue vocal actif' : '○ Dialogue vocal'}
            </button>
            {voice.active && !voice.streaming && (
              <span className="chat-voice-hint" role="note">
                Au haut-parleur, le micro se coupe pendant que le modèle parle
                (sinon il s’entend et se répond). Avec un casque, ce serait inutile.
              </span>
            )}
            {voice.active && (
              <span className="chat-voice-hint" role="status">
                {voice.streaming
                  ? 'Réponse en cours — micro coupé pour éviter que le modèle s’entende lui-même.'
                  : (voice.listening ? 'Je vous écoute…' : 'En écoute…')}
              </span>
            )}
            {voice.error && (
              <span className="chat-voice-error" role="alert">{voice.error}</span>
            )}
          </div>

          <ChatComposer
            onSend={send}
            onStop={stop}
            streaming={streaming}
            disabled={Boolean(runtime.error)}
          />
        </footer>
      </div>
    </section>
  );
}

export default ChatPage;
