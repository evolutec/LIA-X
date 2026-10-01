import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NewFolderModal from './NewFolderModal';
import {
  createFolder,
  deleteFolder,
  deleteDocument,
  fetchFolderContents,
  fetchFolderWorkspaces,
  fetchRagStatus,
  fetchWorkspace,
  fetchWorkspaces,
  ingestDocument,
  saveWorkspaceFolders,
  updateFolder,
} from '../chat/ragClient';
import '../rag/rag.css';
import './explorer.css';

const FALLBACK_MAX_BYTES = 64 * 1024 * 1024;
const FALLBACK_EXTENSIONS = [
  '.txt', '.md', '.json', '.html', '.csv', '.yml', '.log', '.xml',
  '.pdf', '.docx', '.doc', '.rtf', '.xlsx', '.xls',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff',
];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'];

const TYPE_LABELS = {
  pdf: 'Document PDF', doc: 'Document Word', docx: 'Document Word',
  xls: 'Feuille de calcul', xlsx: 'Feuille de calcul', csv: 'Fichier CSV',
  png: 'Image PNG', jpg: 'Image JPEG', jpeg: 'Image JPEG', webp: 'Image WEBP',
  gif: 'Image GIF', bmp: 'Image BMP', tif: 'Image TIFF', tiff: 'Image TIFF',
  zip: 'Archive ZIP', txt: 'Document texte', md: 'Document Markdown',
  json: 'Fichier JSON', html: 'Document HTML', yml: 'Fichier YAML',
  log: 'Fichier journal', xml: 'Document XML', rtf: 'Document RTF',
};

function extensionOf(name) {
  return `.${String(name || '').toLowerCase().split('.').pop()}`;
}

/** « 2,4 Mo », « 846 Ko » — séparateur décimal français. */
function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '—';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1).replace('.', ',')} Go`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1).replace('.', ',')} Mo`;
  return `${Math.round(value / 1024)} Ko`;
}

function typeLabel(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return TYPE_LABELS[ext] || (ext ? `Fichier ${ext.toUpperCase()}` : 'Fichier');
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const today = new Date();
  const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === today.toDateString()) return `Aujourd’hui, ${time}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Hier, ${time}`;
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

const countLabel = (count) => `${count} élément${count > 1 ? 's' : ''}`;

const COLUMNS = [
  { key: 'name', label: 'Nom' },
  { key: 'type', label: 'Type' },
  { key: 'size', label: 'Taille' },
  { key: 'date', label: 'Modifié le' },
];

/**
 * Explorateur de fichiers.
 *
 * Deux colonnes, comme un gestionnaire de fichiers classique : l'arborescence
 * à gauche, le contenu du dossier sélectionné à droite. Le dossier courant est
 * partagé par les deux — cliquer à gauche change la table, pas l'inverse.
 *
 * L'ingestion reste asynchrone : un fichier apparaît immédiatement en
 * « indexation… » puis se met à jour, ce qui explique la présence de
 * `ingest_status` sur la ligne.
 */
export default function FileExplorer({ limits, busy, onBusyChange }) {
  // null = racine. Un identifiant = un dossier ouvert.
  const [currentId, setCurrentId] = useState(null);
  const [folders, setFolders] = useState([]);
  // Hiérarchie complète, pour la colonne de gauche : tous les dossiers, pas
  // seulement ceux du niveau ouvert. `folders` ne sert qu'à la table.
  const [tree, setTree] = useState([]);
  const [files, setFiles] = useState([]);
  const [ancestors, setAncestors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [workspaces, setWorkspaces] = useState([]);
  // Dossiers rattachés à au moins un espace : pilule dans la colonne de gauche.
  const [linkedFolders, setLinkedFolders] = useState(() => new Set());

  const [expanded, setExpanded] = useState(() => new Set());
  const [selected, setSelected] = useState(() => new Set());
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });

  const [menu, setMenu] = useState(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [isOcr, setIsOcr] = useState('');
  const fileRef = useRef(null);
  const menuRef = useRef(null);

  const maxBytes = limits?.maxFileBytes || FALLBACK_MAX_BYTES;
  const accepted = limits?.supportedExtensions?.length
    ? limits.supportedExtensions
    : FALLBACK_EXTENSIONS;

  const load = useCallback(async (folderId) => {
    const result = await fetchFolderContents(folderId);
    if (!result.ok) {
      setError(result.error || 'Impossible de lire ce dossier');
      return;
    }
    setFolders(result.folders);
    setFiles(result.files);
    setAncestors(result.ancestors);
    setError('');
  }, []);

  /**
   * Rafraîchit la vue courante, la hiérarchie complète et les espaces.
   *
   * Deux requêtes distinctes, pour deux besoins distincts : la table n'a
   * besoin que du dossier ouvert, tandis que la colonne de gauche affiche
   * TOUTE la hiérarchie. Réutiliser la première pour la seconde ne montrerait
   * qu'un niveau, ce qui est précisément ce qu'on veut éviter.
   */
  const refreshTree = useCallback(async () => {
    const [spaces, detail, all] = await Promise.all([
      fetchWorkspaces(),
      fetchFolderContents(currentId),
      fetchRagStatus(),
    ]);
    if (spaces.ok) setWorkspaces(spaces.workspaces);
    if (all.ok) setTree(all.folders || []);
    if (detail.ok) {
      setFolders(detail.folders);
      setFiles(detail.files);
      setAncestors(detail.ancestors);
    }
  }, [currentId]);

  useEffect(() => {
    setLoading(true);
    load(currentId).finally(() => setLoading(false));
    // Une sélection porte sur un dossier précis : en changer de cible la vide.
    setSelected(new Set());
  }, [currentId, load]);

  useEffect(() => { refreshTree(); }, [refreshTree]);

  // Toute la hiérarchie est chargée : on la déplie d'emblée, sinon la colonne
  // de gauche n'afficherait que les dossiers de premier niveau et les
  // sous-dossiers créés resteraient invisibles.
  useEffect(() => {
    if (tree.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const folder of tree) {
        if (folder.parent_id) next.add(folder.parent_id);
      }
      return next;
    });
  }, [tree]);

  // Referme le menu au clic dehors ou à l'échappement : sans cela il resterait
  // ouvert après avoir choisi une action.
  useEffect(() => {
    if (!menu) return undefined;
    const onPointerDown = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setMenu(null);
    };
    const onKeyDown = (event) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  // Une indexation en cours fait bouger les compteurs : on suit jusqu'à ce que
  // plus rien ne tourne.
  const hasPending = files.some(
    (f) => f.ingest_status === 'pending' || f.ingest_status === 'running',
  );
  useEffect(() => {
    if (!hasPending) return undefined;
    const timer = window.setInterval(() => { load(currentId); }, 2000);
    return () => window.clearInterval(timer);
  }, [hasPending, currentId, load]);

  const currentFolder = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;
  // currentId vaut null à la racine : aucun dossier n'est ouvert, donc le
  // tableau ne liste que les dossiers de premier niveau et aucun fichier.
  const isRoot = !currentId;

  // ---------------------------------------------------------------- arborescence

  /**
   * Enfants directs de chaque dossier, d'après la hiérarchie complète.
   *
   * La clé '__root__' regroupe les dossiers sans parent. Comme la liste
   * contient TOUS les dossiers, l'arbre est complet dès le premier rendu : la
   * colonne de gauche montre toute la hiérarchie, sans dépendre des
   * déploiements successifs.
   */
  const childrenOf = useMemo(() => {
    const map = new Map();
    for (const folder of tree) {
      const key = folder.parent_id || '__root__';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(folder);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    }
    return map;
  }, [tree]);

  /**
   * Arborescence filtrée par la recherche.
   *
   * Un dossier est affiché s'il correspond au terme, ou si l'un de ses
   * ancêtres correspond : chercher « Docs » doit laisser voir un sous-dossier
   * « 2026 » contenu dans un dossier « Docs ». Les autres sont masqués
   * entièrement — les griser prendrait de la place sans indiquer où cliquer.
   */
  const visibleIds = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return null;
    const all = new Map(tree.map((f) => [f.id, f]));
    const keep = new Set();
    for (const folder of tree) {
      let cursor = folder;
      // Remontée des ancêtres, avec une borne : une parent_id corrompu
      // produirait sinon une boucle infinie.
      for (let depth = 0; depth < 64; depth += 1) {
        if (cursor.name.toLowerCase().includes(term)) {
          keep.add(folder.id);
          break;
        }
        const parentId = cursor.parent_id;
        if (!parentId) break;
        const parent = all.get(parentId);
        if (!parent) break;
        cursor = parent;
      }
    }
    return keep;
  }, [tree, search]);

  const isVisible = useCallback(
    (folder) => !visibleIds || visibleIds.has(folder.id),
    [visibleIds],
  );

  const hasChildren = useCallback(
    (folder) => (childrenOf.get(folder.id) || []).length > 0,
    [childrenOf],
  );

  const toggleExpanded = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ---------------------------------------------------------------- actions

  const openFolder = useCallback((id) => setCurrentId(id), []);

  /**
   * Supprime un dossier et tout ce qu'il contient.
   *
   * ON DELETE CASCADE emporte les sous-dossiers, les fichiers et leurs
   * fragments : la suppression est donc irréversible, d'où la confirmation.
   * Distinguée de handleDeleteFile, qui ne retire qu'un fichier.
   */
  const handleDelete = useCallback(async (id) => {
    setError('');
    const result = await deleteFolder(id);
    if (!result.ok) {
      setError(result.error || 'Suppression impossible');
      return;
    }
    setLinkedFolders((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    // Supprimer le dossier ouvert laisserait une vue orpheline : on revient
    // à la racine.
    if (currentId === id) setCurrentId(null);
    else await refreshTree();
  }, [currentId, refreshTree]);

  /**
   * Crée un dossier dans le dossier courant.
   *
   * Retourne `{ error }` en cas d'échec plutôt que d'écrire dans l'état de la
   * page : c'est la modale qui décide d'afficher le message, et elle reste
   * ouverte pour permettre de corriger la saisie.
   */
  const handleCreate = useCallback(async (name) => {
    const trimmed = String(name || '').trim();
    if (!trimmed) return { error: 'Donnez un nom au dossier.' };
    const result = await createFolder(trimmed, null, currentId);
    if (!result.ok) return { error: result.error || 'Création impossible' };
    // Un sous-dossier créé resterait invisible si son parent est replié.
    if (currentId) setExpanded((prev) => new Set(prev).add(currentId));
    await refreshTree();
    return { error: null };
  }, [currentId, refreshTree]);

  const handleRename = useCallback(async (id) => {
    const trimmed = renameValue.trim();
    setRenamingId(null);
    if (!trimmed) return;
    const result = await updateFolder(id, { name: trimmed });
    if (!result.ok) {
      setError(result.error || 'Renommage impossible');
      return;
    }
    await refreshTree();
  }, [renameValue, refreshTree]);

  /**
   * Ouvre le menu contextuel d'un dossier.
   *
   * Les espaces déjà rattachés sont chargés à ce moment-là : les afficher
   * décochés ferait croire qu'aucun ne l'est, et un clic « rattacher »
   * remplacerait la sélection au lieu de l'ajouter.
   */
  const openMenu = useCallback(async (event, folder) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({
      folderId: folder.id,
      x: Math.min(rect.left, window.innerWidth - 240),
      y: Math.min(rect.bottom + 4, window.innerHeight - 280),
      workspaces: [],
      loading: true,
    });
    const result = await fetchFolderWorkspaces(folder.id);
    // Le menu a pu être refermé entre-temps : on ne touche plus à l'état.
    setMenu((prev) => {
      if (!prev || prev.folderId !== folder.id) return prev;
      return { ...prev, workspaces: result.workspaces || [], loading: false };
    });
    setLinkedFolders((prev) => {
      const next = new Set(prev);
      if (result.workspaces?.length) next.add(folder.id);
      return next;
    });
  }, []);

  /**
   * Rattache ou détache un dossier d'un espace.
   *
   * On relit la sélection courante de l'espace et on ajoute ou retire ce seul
   * dossier : les autres dossiers de l'espace ne doivent pas être affectés.
   */
  const toggleWorkspace = useCallback(async (workspaceId, workspaceName, folderId, attached) => {
    setError('');
    const current = await fetchWorkspace(workspaceId);
    if (!current.ok) {
      setError(current.error || 'Espace de travail introuvable');
      return;
    }
    const currentIds = (current.folders || []).map((f) => f.id);
    const next = attached
      ? currentIds.filter((id) => id !== folderId)
      : [...currentIds, folderId];
    const result = await saveWorkspaceFolders(workspaceId, next);
    if (!result.ok) {
      setError(result.error || 'Rattachement impossible');
      return;
    }
    setMenu((prev) => (prev ? {
      ...prev,
      workspaces: attached
        ? prev.workspaces.filter((w) => w.id !== workspaceId)
        : [...prev.workspaces, { id: workspaceId, name: workspaceName }],
    } : prev));
    setLinkedFolders((prev) => {
      const next = new Set(prev);
      if (attached) next.delete(folderId); else next.add(folderId);
      return next;
    });
  }, []);

  // ---------------------------------------------------------------- ingestion

  const handleImport = useCallback(async (event) => {
    const chosen = Array.from(event.target.files || []);
    if (fileRef.current) fileRef.current.value = '';
    if (chosen.length === 0) return;
    if (!currentId) {
      setError('Ouvrez un dossier avant d’importer des fichiers.');
      return;
    }
    setError('');
    onBusyChange?.(true);
    try {
      // Les fichiers sont enchaînés : les envoyer en parallèle ferait saturer
      // la file d’indexation et le navigateur.
      for (const file of chosen) {
        const extension = extensionOf(file.name);
        if (!accepted.includes(extension)) {
          setError(`Format ${extension} non pris en charge : ${file.name}`);
          // eslint-disable-next-line no-continue
          continue;
        }
        if (file.size > maxBytes) {
          setError(`${file.name} dépasse ${formatBytes(maxBytes)}.`);
          // eslint-disable-next-line no-continue
          continue;
        }
        // L'OCR est nettement plus lent : on l'annonce avant l'envoi, sinon
        // l'interface semble figée pendant une minute.
        setIsOcr(IMAGE_EXTENSIONS.includes(extension) ? file.name : '');
        // eslint-disable-next-line no-await-in-loop
        const result = await ingestDocument({ folderId: currentId, file });
        if (result?.error) setError(result.error);
      }
      await load(currentId);
    } finally {
      setIsOcr('');
      onBusyChange?.(false);
    }
  }, [currentId, accepted, maxBytes, load, onBusyChange]);

  const handleDeleteFile = useCallback(async (id) => {
    await deleteDocument(id);
    await load(currentId);
  }, [currentId, load]);

  // ---------------------------------------------------------------- tableau

  const rows = useMemo(() => {
    const all = [
      ...folders.map((f) => ({ kind: 'folder', id: f.id, folder: f })),
      ...files.map((f) => ({ kind: 'file', id: f.id, file: f })),
    ];
    const dir = sort.dir === 'asc' ? 1 : -1;
    const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
    const nameOf = (row) => (row.kind === 'folder'
      ? row.folder.name
      : (row.file.title || row.file.source_path || ''));
    const sizeOf = (row) => Number((row.kind === 'folder'
      ? row.folder.total_bytes : row.file.size_bytes) || 0);
    const dateOf = (row) => (row.kind === 'folder'
      ? row.folder.created_at
      : (row.file.updated_at || row.file.created_at));

    return all.sort((a, b) => {
      // Les dossiers d'abord : c'est la convention de tout explorateur, et un
      // tri alphabétique global les mélangerait aux fichiers.
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      if (sort.key === 'size') return (sizeOf(a) - sizeOf(b)) * dir;
      if (sort.key === 'type') {
        const ta = a.kind === 'folder' ? '' : typeLabel(nameOf(a));
        const tb = b.kind === 'folder' ? '' : typeLabel(nameOf(b));
        return ta.localeCompare(tb, 'fr') * dir;
      }
      if (sort.key === 'date') return (new Date(dateOf(a)) - new Date(dateOf(b))) * dir;
      return collator.compare(nameOf(a), nameOf(b)) * dir;
    });
  }, [folders, files, sort]);

  const toggleSort = useCallback((key) => {
    setSort((prev) => (prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' }));
  }, []);

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => (rows.every((r) => prev.has(r.id))
      ? new Set()
      : new Set(rows.map((r) => r.id))));
  }, [rows]);

  // ---------------------------------------------------------------- résumé

  const totalBytes = useMemo(() => folders.reduce(
    (sum, f) => sum + Number(f.total_bytes || 0), 0,
  ) + files.reduce((sum, f) => sum + Number(f.size_bytes || 0), 0), [folders, files]);

  const selectedNames = useMemo(() => rows
    .filter((r) => selected.has(r.id))
    .map((r) => (r.kind === 'folder'
      ? r.folder.name
      : (r.file.title || r.file.source_path))), [rows, selected]);

  /** Une entrée de la colonne de gauche : racine ou sous-dossier. */
  const renderTreeItem = (folder, depth) => {
    const isOpen = expanded.has(folder.id);
    // En recherche, un parent reste dépliable même vide à l'écran : ses
    // enfants filtrés doivent pouvoir être atteints.
    const canExpand = hasChildren(folder);
    if (!isVisible(folder)) return null;
    return (
      <li key={folder.id}>
        <div
          className={`explorer-tree-row${currentId === folder.id ? ' is-active' : ''}`}
          style={depth > 0 ? { paddingLeft: 8 + depth * 14 } : undefined}
          onContextMenu={(event) => openMenu(event, folder)}
        >
          <button
            type="button"
            className="explorer-tree-twisty"
            onClick={() => canExpand && toggleExpanded(folder.id)}
            aria-label={canExpand ? (isOpen ? 'Replier' : 'Déplier') : undefined}
            aria-expanded={canExpand ? isOpen : undefined}
            tabIndex={canExpand ? 0 : -1}
          >
            {canExpand ? (isOpen ? '▾' : '▸') : ''}
          </button>
          {/* Le champ remplace le bouton pendant le renommage : un <input> ne
              peut pas être imbriqué dans un <button>, ce qui rendrait le
              HTML invalide et le clic droit sur le champ cassé. */}
          {renamingId === folder.id ? (
            <input
              className="explorer-tree-rename"
              value={renameValue}
              autoFocus
              onChange={(event) => setRenameValue(event.target.value)}
              onBlur={() => handleRename(folder.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleRename(folder.id);
                if (event.key === 'Escape') setRenamingId(null);
              }}
              aria-label={`Renommer ${folder.name}`}
            />
          ) : (
            <button
              type="button"
              className="explorer-tree-item"
              onClick={() => openFolder(folder.id)}
              onDoubleClick={() => {
                setRenameValue(folder.name);
                setRenamingId(folder.id);
              }}
              title="Double-clic pour renommer"
            >
              <span className="explorer-tree-icon" aria-hidden="true">🗀</span>
              <span className="explorer-tree-name">{folder.name}</span>
              {linkedFolders.has(folder.id) && (
                <span className="explorer-tree-dot" title="Rattaché à un espace" />
              )}
            </button>
          )}
        </div>
        {isOpen && canExpand && (
          <ul className="explorer-tree is-nested">
            {(childrenOf.get(folder.id) || [])
              .map((child) => renderTreeItem(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="explorer">
      {/* -------------------------------------------- colonne de gauche */}
      <aside className="explorer-side" aria-label="Dossiers">
        <div className="explorer-side-head">
          <h3 className="explorer-side-title">Dossiers</h3>
          {/* La création se fait d'ici : on navigue jusqu'au dossier voulu, puis
              on clique sur + plutôt que de choisir un parent dans une liste. */}
          <button
            type="button"
            className="explorer-side-add"
            onClick={() => setNewFolderOpen(true)}
            aria-label="Nouveau dossier"
            title="Nouveau dossier"
          >
            +
          </button>
        </div>

        <div className="explorer-search">
          <span className="explorer-search-icon" aria-hidden="true">🔍</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Rechercher un dossier"
            aria-label="Rechercher un dossier"
          />
          {search && (
            <button
              type="button"
              className="explorer-search-clear"
              onClick={() => setSearch('')}
              aria-label="Effacer la recherche"
            >
              ✕
            </button>
          )}
        </div>

        <ul className="explorer-tree">
          {/* « Mes Dossiers » reste en haut quoi qu'il arrive, et se met en
              surbrillance quand on est à la racine : c'est le seul moyen
              remonter, le fil d'Ariane ayant été retiré. */}
          <li>
            <button
              type="button"
              className={`explorer-tree-row explorer-tree-root${isRoot ? ' is-active' : ''}`}
              onClick={() => setCurrentId(null)}
            >
              <span className="explorer-tree-twisty" />
              <span className="explorer-tree-item">
                <span className="explorer-tree-icon" aria-hidden="true">📁</span>
                <span className="explorer-tree-name">Mes Dossiers</span>
              </span>
            </button>
          </li>
          {(childrenOf.get('__root__') || []).map((folder) => renderTreeItem(folder, 0))}
        </ul>

        {search.trim() && (childrenOf.get('__root__') || []).every((f) => !isVisible(f)) && (
          <p className="explorer-side-empty">Aucun dossier ne correspond.</p>
        )}

        {workspaces.length > 0 && (
          <p className="explorer-side-hint">
            Clic droit sur un dossier pour le rattacher à un espace.
          </p>
        )}
      </aside>

      {/* -------------------------------------------- colonne principale */}
      <section className="explorer-main">
        <header className="explorer-head">
          <div className="explorer-head-text">
            <h2 className="explorer-title">
              {currentFolder ? currentFolder.name : 'Mes Dossiers'}
            </h2>
            <p className="explorer-subtitle">
              {isRoot
                ? `${countLabel(folders.length)} · dossiers de premier niveau`
                : `${countLabel(rows.length)} · ${formatBytes(totalBytes)} · Modifié ${formatDate(currentFolder?.created_at).toLowerCase()}`}
            </p>
          </div>
          <div className="explorer-actions">
            <button
              type="button"
              className="explorer-import"
              onClick={() => fileRef.current?.click()}
              disabled={isRoot || busy}
              title={isRoot ? 'Ouvrez un dossier pour importer' : 'Importer des fichiers'}
            >
              Importer
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              onChange={handleImport}
              accept={accepted.join(',')}
              className="explorer-file-input"
              aria-label="Fichiers à importer"
            />
          </div>
        </header>

        {isOcr && (
          <p className="explorer-notice">Lecture de {isOcr} (OCR), cela peut prendre une minute…</p>
        )}
        {error && <p className="explorer-error" role="alert">{error}</p>}

        <div className="explorer-table-wrap">
          <table className="explorer-table">
            <thead>
              <tr>
                <th scope="col" className="explorer-col-select">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label="Tout sélectionner"
                  />
                </th>
                {COLUMNS.map((column) => (
                  <th key={column.key} scope="col" className={`is-${column.key}`}>
                    <button type="button" onClick={() => toggleSort(column.key)}>
                      {column.label}
                      <span aria-hidden="true">
                        {sort.key === column.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </span>
                    </button>
                  </th>
                ))}
                <th scope="col" className="explorer-col-menu">
                  <span className="explorer-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="explorer-empty">Chargement…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="explorer-empty">
                    {isRoot
                      ? 'Aucun dossier. Créez-en un pour commencer.'
                      : 'Ce dossier est vide. Utilisez « Importer » pour ajouter des fichiers.'}
                  </td>
                </tr>
              )}
              {!loading && rows.map((row) => {
                const isSelected = selected.has(row.id);
                const isPending = row.kind === 'file'
                  && (row.file.ingest_status === 'pending' || row.file.ingest_status === 'running');
                const isFailed = row.kind === 'file' && row.file.ingest_status === 'error';
                const name = row.kind === 'folder'
                  ? row.folder.name
                  : (row.file.title || row.file.source_path);
                const date = formatDate(row.kind === 'folder'
                  ? row.folder.created_at
                  : (row.file.updated_at || row.file.created_at));
                const hint = isFailed
                  ? row.file.error_detail
                  : (row.kind === 'folder' ? row.folder.name : row.file.source_path);

                return (
                  <tr
                    key={row.id}
                    className={`${isSelected ? 'is-selected' : ''}${isFailed ? ' is-error' : ''}`}
                    onContextMenu={(event) => row.kind === 'folder' && openMenu(event, row.folder)}
                  >
                    <td className="explorer-col-select">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(row.id)}
                        aria-label={`Sélectionner ${name}`}
                      />
                    </td>
                    <td className="explorer-col-name">
                      <button
                        type="button"
                        className="explorer-name-button"
                        onClick={() => (row.kind === 'folder'
                          ? openFolder(row.id)
                          : toggleSelect(row.id))}
                        onDoubleClick={() => {
                          // Un fichier ne se renomme pas : le renommage est
                          // proposé uniquement pour les dossiers.
                          if (row.kind !== 'folder') return;
                          setRenameValue(row.folder.name);
                          setRenamingId(row.id);
                        }}
                        title={row.kind === 'folder' ? `${hint} — double-clic pour renommer` : hint}
                      >
                        <span className="explorer-row-icon" aria-hidden="true">
                          {row.kind === 'folder' ? '🗀' : '📄'}
                        </span>
                        {renamingId === row.id ? (
                          <input
                            className="explorer-rename"
                            value={renameValue}
                            autoFocus
                            onChange={(event) => setRenameValue(event.target.value)}
                            onBlur={() => handleRename(row.id)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') handleRename(row.id);
                              if (event.key === 'Escape') setRenamingId(null);
                            }}
                          />
                        ) : (
                          <>
                            <span className="explorer-name-text">{name}</span>
                            {isPending && <span className="explorer-badge">indexation…</span>}
                            {isFailed && <span className="explorer-badge is-error">échec</span>}
                          </>
                        )}
                      </button>
                    </td>
                    <td className="explorer-col-type">
                      {row.kind === 'folder' ? 'Dossier' : typeLabel(name)}
                    </td>
                    <td className="explorer-col-size">
                      {row.kind === 'folder' ? '—' : formatBytes(row.file.size_bytes)}
                    </td>
                    <td className="explorer-col-date">{date}</td>
                    <td className="explorer-col-menu">
                      {row.kind === 'folder' ? (
                        <button
                          type="button"
                          className="explorer-row-action"
                          onClick={(event) => openMenu(event, row.folder)}
                          aria-label={`Actions sur ${name}`}
                          title="Actions"
                        >
                          ⋯
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="explorer-row-action"
                          onClick={() => handleDeleteFile(row.id)}
                          aria-label={`Supprimer ${name}`}
                          title="Supprimer le fichier"
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <footer className="explorer-footer">
          {selectedNames.length > 0 ? (
            <>
              <span className="explorer-selection">
                ✓ {countLabel(selectedNames.length)}
                {selectedNames.length === 1 ? ` · ${selectedNames[0]}` : ''}
              </span>
              <button type="button" onClick={() => setSelected(new Set())}>Désélectionner</button>
            </>
          ) : (
            <span className="explorer-total">{countLabel(rows.length)} au total</span>
          )}
        </footer>
      </section>

      <NewFolderModal
        isOpen={newFolderOpen}
        parentName={currentFolder?.name}
        busy={creatingFolder}
        onClose={() => setNewFolderOpen(false)}
        onSubmit={async (name) => {
          setCreatingFolder(true);
          // finally : sans lui, une exception laisserait le bouton « Création… »
          // bloqué pour toujours.
          try {
            return await handleCreate(name);
          } finally {
            setCreatingFolder(false);
          }
        }}
      />

      {/* -------------------------------------------- menu contextuel */}
      {menu && (
        <div
          ref={menuRef}
          className="explorer-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          <p className="explorer-menu-title">
            {folders.find((f) => f.id === menu.folderId)?.name}
          </p>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const folder = folders.find((f) => f.id === menu.folderId);
              setRenameValue(folder?.name || '');
              setRenamingId(menu.folderId);
              setMenu(null);
            }}
          >
            Renommer
          </button>

          <p className="explorer-menu-group">Rattacher à un espace</p>
          {menu.loading && <p className="explorer-menu-empty">Chargement…</p>}
          {!menu.loading && workspaces.length === 0 && (
            <p className="explorer-menu-empty">Aucun espace de travail.</p>
          )}
          {!menu.loading && workspaces.map((workspace) => {
            const attached = menu.workspaces.some((w) => w.id === workspace.id);
            return (
              <button
                key={workspace.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={attached}
                onClick={() => toggleWorkspace(
                  workspace.id, workspace.name, menu.folderId, attached,
                )}
              >
                <span className="explorer-menu-check" aria-hidden="true">
                  {attached ? '☑' : '☐'}
                </span>
                {workspace.name}
              </button>
            );
          })}

          <p className="explorer-menu-group">Actions</p>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            onClick={() => { handleDelete(menu.folderId); setMenu(null); }}
          >
            Supprimer le dossier
          </button>
        </div>
      )}
    </div>
  );
}
