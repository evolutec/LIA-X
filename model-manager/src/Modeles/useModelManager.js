import { useEffect, useMemo, useRef, useState } from "react";
import { useStatusToast } from "../StatusToasts/StatusToasts";
import { requestNotificationPermission } from "../ModelDownloads/ModelDownloads";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

// Etat et actions de la page Modèles : chargement/dechargement des modeles,
// contexte, gpu_layers, telechargements en arriere-plan et diagnostic materiel.
// Le hook ne rend rien : il expose uniquement des donnees et des callbacks, ce
// qui garde la vue (ModelesPage.jsx) sans etat et le shell (App.jsx) incapable
// de modifier le contenu de la page Modèles.
export function useModelManager() {
  const [huggingfaceUrl, setHuggingfaceUrl] = useState("");

  // ── Modèles épinglés : résidence permanente en VRAM ─────────────────────────
  // L'ensemble est relu au montage et après chaque bascule. Le serveur
  // transforme un nom de fichier épinglé en sleep_idle_seconds = -1, ce qui fait
  // omettre --sleep-idle-seconds au contrôleur : llama-server ne décharge alors
  // jamais et le modèle reste entièrement chargé, donc plus de latence de
  // rechargement sur les premières requêtes.
  const [pinnedModels, setPinnedModels] = useState(() => new Set());

  async function loadPinnedModels() {
    try {
      const data = await apiFetch('/api/models/pinned');
      setPinnedModels(new Set(Array.isArray(data?.pinned) ? data.pinned : []));
    } catch {
      // Base indisponible : aucun modèle n'est épinglé, l'application reste
      // utilisable. On ne bloque pas le chargement de la page pour cela.
      setPinnedModels(new Set());
    }
  }


  /** Le nom affiché ne porte pas l'extension : la base stocke le fichier. */
  function toFilename(modelName) {
    const name = String(modelName || '').trim();
    if (!name) return '';
    return name.toLowerCase().endsWith('.gguf') ? name : `${name}.gguf`;
  }

  // Lecture initiale de l'ensemble épinglé, au montage de la page.
  useEffect(() => {
    loadPinnedModels();
  }, []);
  async function handleTogglePin(modelName) {
    const filename = toFilename(modelName);
    if (!filename) return;
    try {
      if (pinnedModels.has(filename)) {
        await apiFetch('/api/models/pin', { method: 'DELETE', body: { filename } });
      } else {
        await apiFetch('/api/models/pin', { method: 'POST', body: { filename } });
        // Un modèle déjà chargé reste en sleep-idle tant qu'il n'est pas
        // relancé : on le recharge donc immédiatement pour que l'épinglage
        // prenne effet tout de suite.
        const row = buildRows().find((item) => item.name === modelName);
        if (row?.loaded) await handleReloadModel(modelName);
      }
      await loadPinnedModels();
      await refreshAllModelState({ silent: true });
    } catch (error) {
      updateStatus(`${modelName} : échec de l'épinglage — ${error.message}`);
    }
  }
  const [ollamaName, setOllamaName] = useState("");
  const [hfModelName, setHfModelName] = useState("");
  const [availableFiles, setAvailableFiles] = useState([]);
  const [modelsHostDir, setModelsHostDir] = useState(null);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [hostPathCopied, setHostPathCopied] = useState(false);
  const [loadedModels, setLoadedModels] = useState([]);
  const [activeModel, setActiveModel] = useState("");
  const [version, setVersion] = useState(null);
  // Le badge « Runtime » ne doit pas annoncer « hors ligne » avant la première
  // réponse de l'API ni après un échec isolé (contrôleur en cours de redémarrage,
  // conteneur en cours de recréation) : on distingue « en cours de vérification »
  // d'un véritable hors ligne.
  const [versionChecked, setVersionChecked] = useState(false);
  const versionFailRef = useRef(0);
  // Message système affiché en toast discret, plus en bannière pleine largeur.
  // Ces messages confirment des actions courantes (« Synchronisation
  // terminée ») et n'ont pas leur place au milieu de la page.
  const statusToast = useStatusToast();
  const [loading, setLoading] = useState(false);
  // Adresse de l'API OpenAI-compatible : calculée depuis l'URL de l'UI elle-même,
  // donc toujours correcte quel que soit le port/hôte utilisé.
  const apiBaseUrl = `${window.location.origin}/v1`;
  const [apiCopied, setApiCopied] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [controllerHealth, setControllerHealth] = useState({ ok: true, controller_ok: true, detail: '', runtime: null });
  const [controllerLoading, setControllerLoading] = useState(false);
  const [downloads, setDownloads] = useState([]);
  const downloadsRef = useRef([]);
  const autoLoadRef = useRef(new Set());
  const loadFileRef = useRef(null);
  const [sortColumn, setSortColumn] = useState("name");
  const [sortDirection, setSortDirection] = useState("asc");
  const [currentPage, setCurrentPage] = useState('home');
  const [modelDetails, setModelDetails] = useState(null);
  const [modelDetailsLoading, setModelDetailsLoading] = useState(false);
  const [modelContextOverrides, setModelContextOverrides] = useState({});
  const [modelContextNeedsReload, setModelContextNeedsReload] = useState({});
  const [hardwareProfile, setHardwareProfile] = useState(null);
  // Diagnostic matériel complet (backend prouvé, mémoire GPU, binaire validé) lu
  // depuis la détection réellement effectuée par l'hôte (installateur/détecteur).
  const [hardwareDiagnostic, setHardwareDiagnostic] = useState(null);
  const [hardwareRescanLoading, setHardwareRescanLoading] = useState(false);
  const [recommendedRuntime, setRecommendedRuntime] = useState(null);
  const [showRecommendedRuntimeModal, setShowRecommendedRuntimeModal] = useState(false);
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embeddingModelLoading, setEmbeddingModelLoading] = useState(false);
  // P-UX : feedback de progression pendant un chargement (parsing → spawn → warmup → prêt).
  const [loadProgress, setLoadProgress] = useState(null);
  const loadProgressTimerRef = useRef(null);

  useEffect(() => {
    refreshAllModelState();
    fetchControllerHealth();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!loading && !pendingAction) {
        refreshAllModelState({ silent: true });
        fetchControllerHealth();
      }
    }, 25000);
    return () => window.clearInterval(intervalId);
  }, [loading, pendingAction]);

  // Référence stable vers le chargement de modèle (utilisée par le suivi des
  // téléchargements pour charger automatiquement le modèle une fois prêt).
  useEffect(() => {
    loadFileRef.current = handleLoadFile;
  });

  // Suivi des téléchargements lancés en tâche de fond : progression réelle,
  // notification de fin et chargement automatique si demandé. Le polling
  // reprend au montage, donc un téléchargement démarré avant un rechargement
  // de page reste visible.
  useEffect(() => {
    let stopped = false;
    let firstRun = true;

    const tick = async () => {
      if (stopped) return;
      const hasWork = downloadsRef.current.length > 0 || autoLoadRef.current.size > 0;
      if (!firstRun && !hasWork) return;
      firstRun = false;

      const list = await refreshDownloads();
      if (stopped || !Array.isArray(list)) return;

      for (const modelName of [...autoLoadRef.current]) {
        const job = list.find((item) => item.model === modelName);
        if (!job) continue;
        if (job.done) {
          autoLoadRef.current.delete(modelName);
          updateStatus(`Modèle prêt : chargement de ${job.model}…`);
          loadFileRef.current?.(job.model);
        } else if (job.error || job.cancelled) {
          autoLoadRef.current.delete(modelName);
        }
      }
    };

    tick();
    const intervalId = window.setInterval(tick, 1500);
    return () => {
      stopped = true;
      window.clearInterval(intervalId);
    };
  }, []);

  function log(...args) {
    // LOGS DÉSACTIVÉS PAR DÉFAUT: commenter pour réactiver
    // console.log('[App]', ...args);
  }

  function normalizeUrl(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  async function parseJson(response) {
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }

  async function apiFetch(path, options = {}) {
    const url = `${apiBase}${path}`;
    const init = {
      method: options.method || 'GET',
      // Token injecté par le serveur dans index.html (même origine). Absent
      // si LIA_API_TOKEN n'est pas activé : l'en-tête est alors simplement
      // inutile, et le serveur ne l'exige pas.
      headers: {
        'Content-Type': 'application/json',
        ...(window.__LIA_TOKEN__ ? { 'X-LIA-Token': window.__LIA_TOKEN__ } : {}),
        ...(options.headers || {}),
      },
      cache: 'no-store',
      ...options,
    };
    if (options.body !== undefined && typeof options.body !== 'string') {
      init.body = JSON.stringify(options.body);
    }
    if (!init.body) {
      delete init.body;
    }

    // LOGS DÉSACTIVÉS POUR LES REQUÊTES GET SILENCIEUSES
    // log('fetch', init.method, url, options.body || 'no body');
    const response = await fetch(url, init);
    const payload = await parseJson(response);
    // LOGS DÉSACTIVÉS POUR LES RÉPONSES
    // log('fetch result', init.method, url, response.status, payload);
    if (!response.ok) {
      const message = payload?.detail || payload?.message || response.statusText || String(payload);
      throw new Error(message);
    }
    return payload;
  }

  async function waitForModelFile(expectedName, timeoutMs = 600000) {
    const start = Date.now();
    const expected = String(expectedName || '').trim().toLowerCase();
    if (!expected) return null;

    while (Date.now() - start < timeoutMs) {
      try {
        const data = await apiFetch('/api/models/available');
        const files = Array.isArray(data?.files) ? data.files : [];
        const match = files.find((item) => String(item?.name || '').toLowerCase() === expected);
        if (match) {
          return match;
        }
      } catch {
        // UI temporairement indisponible : on retente
      }
      await delay(2000);
    }

    return null;
  }

  async function fetchControllerHealth() {
    setControllerLoading(true);
    try {
      const data = await apiFetch('/health');
      setControllerHealth(data);
    } catch (err) {
      setControllerHealth({ ok: false, controller_ok: false, detail: err?.message || 'Impossible de contacter le contrôleur', runtime: null });
    } finally {
      setControllerLoading(false);
    }
  }

  async function handleRestartController() {
    if (loading || pendingAction) return;
    setLoading(true);
    setPendingAction({ model: 'controller', type: 'redémarrage' });
    updateStatus('Redémarrage du contrôleur...');
    try {
      await apiFetch('/api/controller/restart', { method: 'POST' });
      await fetchControllerHealth();
      await refreshAllModelState({ silent: true });
      updateStatus('Contrôleur redémarré.');
    } catch (err) {
      updateStatus(`Échec du redémarrage du contrôleur — ${err.message}`);
      throw err;
    } finally {
      setPendingAction(null);
      setLoading(false);
    }
  }

  function formatBytes(value) {
    if (value == null || value === '') return '—';
    const number = Number(value);
    if (Number.isNaN(number)) return String(value);
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = number;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size.toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
  }

  // Provenance de la VRAM affichée pour un modèle chargé : on l'explicite dans
  // le tooltip pour que l'utilisateur sache si la valeur est mesurée sur l'hôte
  // (processus llama-server.exe) ou seulement estimée.
  function vramSourceLabel(row) {
    const peakHint = row.vramPeak && row.vramPeak > (row.vramSize || 0) * 1.5
      ? ` Pic observé sur le processus : ${formatBytes(row.vramPeak)} (le modèle est probablement en veille, sa VRAM étant libérée après inactivité).`
      : '';
    if (row.vramSource === 'gpu-process') {
      return `Mesuré sur l'hôte : mémoire GPU attribuée au processus llama-server.exe (compteurs Windows « GPU Process Memory »).${peakHint}`;
    }
    if (row.vramSource === 'estimate') {
      return `Estimé par le controller (poids du modèle + contexte + couches GPU).${peakHint}`;
    }
    if (row.vramSource === 'process-ram') {
      return `Mesuré sur l'hôte : mémoire système (WorkingSet) du processus llama-server.exe.${peakHint}`;
    }
    return 'Mémoire consommée par le modèle chargé.';
  }

  function vramSourceBadge(source) {
    if (source === 'gpu-process') return 'GPU';
    if (source === 'estimate') return '≈';
    if (source === 'process-ram') return 'RAM';
    return '';
  }

  function formatShortDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function sortRows(rows) {
    return rows.sort((a, b) => {
      if (sortColumn === 'name') {
        return sortDirection === 'asc'
          ? a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
          : b.name.localeCompare(a.name, 'fr', { sensitivity: 'base' });
      }
      if (sortColumn === 'status') {
        const order = (item) => (item.active ? 0 : item.loaded ? 1 : 2);
        return sortDirection === 'asc' ? order(a) - order(b) : order(b) - order(a);
      }
      if (sortColumn === 'contextLength') {
        const valueA = Number(a.contextLength) || 0;
        const valueB = Number(b.contextLength) || 0;
        return sortDirection === 'asc' ? valueA - valueB : valueB - valueA;
      }
      if (sortColumn === 'gpuLayers') {
        const valueA = Number(a.gpuLayers) || 0;
        const valueB = Number(b.gpuLayers) || 0;
        return sortDirection === 'asc' ? valueA - valueB : valueB - valueA;
      }
      const valueA = a[sortColumn] ?? 0;
      const valueB = b[sortColumn] ?? 0;
      return sortDirection === 'asc' ? valueA - valueB : valueB - valueA;
    });
  }

  function normalizeContextValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const rounded = Math.round(number);
    return rounded > 0 ? rounded : null;
  }

  function getSliderMinContext() {
    return 512;
  }

  function getRowRuntimeContext(row) {
    if (!row) return null;
    if (row.loaded && normalizeContextValue(row?.runtimeContextLength) !== null) {
      return normalizeContextValue(row.runtimeContextLength);
    }
    return normalizeContextValue(row?.contextLength);
  }

  function getSliderMaxContext(row) {
    const runtimeContext = getRowRuntimeContext(row);
    const recommended = normalizeContextValue(recommendedRuntime?.context);
    const metadataContext = normalizeContextValue(row?.contextLength);
    const baseMax = runtimeContext ?? 32768;
    return Math.max(getSliderMinContext(), baseMax, recommended ?? 0, metadataContext ?? 0);
  }

  function getDefaultContext(row) {
    const runtimeContext = getRowRuntimeContext(row);
    const recommended = normalizeContextValue(recommendedRuntime?.context);
    if (runtimeContext !== null) {
      return runtimeContext;
    }
    if (recommended !== null) {
      return recommended;
    }
    return 8192;
  }

  function getRequestedContextForRow(row) {
    if (!row?.name) return getDefaultContext(row);
    const override = normalizeContextValue(modelContextOverrides[row.name]);
    if (override) return override;
    return getDefaultContext(row);
  }

  function handleContextSliderChange(row, rawValue) {
    if (!row?.name) return;
    const normalized = normalizeContextValue(rawValue);
    if (!normalized) return;

    setModelContextOverrides((current) => ({
      ...current,
      [row.name]: normalized,
    }));

    if (row.loaded) {
      setModelContextNeedsReload((current) => ({
        ...current,
        [row.name]: true,
      }));
    }
  }

  function handleContextSliderCommit(row) {
    if (!row?.name || !row.loaded) return;
    updateStatus(`${row.name}: contexte modifié (${getRequestedContextForRow(row)}). Déchargez/rechargez le modèle pour appliquer.`);
  }


  function buildRows() {
    // On veut une ligne pour chaque fichier du dossier, enrichie si chargé
    const fileMap = new Map();
    availableFiles.forEach((file) => {
      const name = String(file?.name || '');
      if (!name) return;
      const rawGpuLayers = Number(file.gpu_layers);
      fileMap.set(name, {
        name,
        filename: file.filename || `${name}.gguf`,
        loaded: !!file.loaded,
        active: name === activeModel,
        diskSize: file.size ?? null,
        modifiedAt: file.modified_at ?? null,
        vramSize: null,
        expiresAt: null,
        contextLength: normalizeContextValue(file.context_length),
        runtimeContextLength: null,
        gpuLayers: Number.isFinite(rawGpuLayers) ? rawGpuLayers : null,
        embedding_capable: file.embedding_capable ?? false,
        // État RÉEL de l'instance (drapeau --embedding posé par le contrôleur)
        // et provenance de la détection (métadonnées GGUF vs nom de fichier).
        // Sans ces deux champs, l'UI affichait « Embedding » alors que
        // /v1/embeddings répondait 501 sur l'instance en cours.
        embedding_active: file.embedding_active ?? false,
        embedding_source: file.embedding_source ?? null,
      });
    });
    // Pour chaque modèle chargé, fusionne les infos si déjà dans le dossier, sinon ajoute une ligne "orpheline"
    loadedModels.forEach((item) => {
      const name = String(item?.model || '');
      if (!name) return;
  const itemContext = normalizeContextValue(item.context_length) ?? normalizeContextValue(item.context);
      if (fileMap.has(name)) {
        const base = fileMap.get(name);
        fileMap.set(name, {
          ...base,
          loaded: true,
          active: name === activeModel,
          vramSize: item.size_vram ?? base.vramSize,
          expiresAt: item.expires_at ?? base.expiresAt,
          contextLength: base.contextLength ?? itemContext ?? null,
          runtimeContextLength: itemContext ?? base.runtimeContextLength ?? null,
          gpuLayers: base.gpuLayers ?? null,
          embedding_capable: item.embedding_capable ?? base.embedding_capable ?? false,
          embedding_active: item.embedding_active ?? base.embedding_active ?? false,
          embedding_source: item.embedding_source ?? base.embedding_source ?? null,
        });
      } else {
        fileMap.set(name, {
          name,
          filename: item.filename || `${name}.gguf`,
          loaded: true,
          active: name === activeModel,
          diskSize: null,
          modifiedAt: null,
          vramSize: item.size_vram ?? null,
          expiresAt: item.expires_at ?? null,
          contextLength: itemContext ?? null,
          runtimeContextLength: itemContext ?? null,
          gpuLayers: null,
          embedding_capable: item.embedding_capable ?? false,
          embedding_active: item.embedding_active ?? false,
          embedding_source: item.embedding_source ?? null,
        });
      }
    });
    return sortRows(Array.from(fileMap.values()));
  }

  function updateStatus(message) {
    // Le journal reste alimenté : le message n'est plus affiché durablement mais
    // il doit rester consultable dans l'onglet Journaux.
    log('status', message);
    statusToast.push(message);
  }

  async function refreshHardwareProfile(silent = false) {
    try {
      const data = await apiFetch('/api/hardware-profile');
      setHardwareProfile(data.profile || null);
      setRecommendedRuntime(data.recommended_runtime || null);
    } catch (err) {
      setHardwareProfile(null);
      setRecommendedRuntime(null);
      if (!silent) updateStatus(`Impossible de lire le profil matériel : ${err.message}`);
    }
  }

  // Diagnostic matériel détaillé : capacités réellement détectées (cuda/rocm/
  // vulkan/cpu), mémoire GPU dédiée/unifiée et validation réelle du binaire.
  async function refreshHardwareDiagnostic(silent = false) {
    try {
      const data = await apiFetch('/api/hardware/diagnostic');
      setHardwareDiagnostic(data.diagnostic || null);
    } catch (err) {
      setHardwareDiagnostic(null);
      if (!silent) log('hardware', `Diagnostic matériel indisponible : ${err.message}`);
    }
  }

  // Réanalyse matérielle sans réinstallation : déléguée au contrôleur hôte, qui
  // relance exactement le même détecteur que l'installateur.
  async function rescanHardware() {
    setHardwareRescanLoading(true);
    updateStatus('Réanalyse du matériel en cours...');
    try {
      const data = await apiFetch('/api/hardware/rescan', { method: 'POST' });
      setHardwareDiagnostic(data.diagnostic || null);
      if (data.hardware_profile) setHardwareProfile(data.hardware_profile);
      await refreshHardwareProfile(true);
      const label = data?.diagnostic?.backend_label || data?.diagnostic?.backend || 'inconnu';
      if (data.ok) {
        updateStatus(`Matériel réanalysé : backend ${label}${data.diagnostic?.binary_validated ? ' (binaire validé)' : ''}`);
      } else {
        updateStatus(`Réanalyse terminée avec avertissement (code ${data.exit_code ?? '?'}) : backend ${label}`);
      }
    } catch (err) {
      updateStatus(`Réanalyse matérielle impossible : ${err.message}`);
    } finally {
      setHardwareRescanLoading(false);
    }
  }

  async function refreshAllModelState(options = {}) {
    const { silent = false } = options;
    // LOG DÉSACTIVÉ:
    // log('refreshAllModelState', options);
    try {
      await Promise.all([
        refreshVersion(silent),
        refreshAvailableFiles(silent),
        refreshLoadedModels(silent),
        refreshActiveModel(silent),
        refreshEmbeddingModel(silent),
        refreshHardwareProfile(silent),
        refreshHardwareDiagnostic(silent),
      ]);
      if (!silent) updateStatus('Synchronisation terminée.');
    } catch (err) {
      if (!silent) updateStatus(`Erreur de synchronisation : ${err.message}`);
    }
  }

  async function refreshVersion(silent = false) {
    try {
      const data = await apiFetch('/api/version');
      versionFailRef.current = 0;
      setVersion(data);
      setVersionChecked(true);
    } catch (err) {
      // Un échec isolé (contrôleur en cours de redémarrage, conteneur recréé) ne
      // doit pas faire clignoter le badge en « hors ligne » : on ne bascule
      // qu'après deux échecs consécutifs, le polling reprenant toutes les 25 s.
      versionFailRef.current += 1;
      if (versionFailRef.current >= 2) setVersion(null);
      setVersionChecked(true);
      if (!silent) updateStatus(`Impossible de lire la version : ${err.message}`);
    }
  }

  async function refreshAvailableFiles(silent = false) {
    try {
      const data = await apiFetch('/api/models/available');
      setAvailableFiles(Array.isArray(data.files) ? data.files : []);
      setModelsHostDir(data.hostDir || null);
    } catch (err) {
      setAvailableFiles([]);
      if (!silent) updateStatus(`Impossible de lister les fichiers : ${err.message}`);
    }
  }

  // Ouvre le dossier des modèles côté hôte via le controller / host-launcher.
  // Le service Windows tourne en session 0 : on utilise CreateProcessAsUser
  // pour ouvrir l'Explorateur dans la session interactive de l'utilisateur
  // et forcer la fenêtre au premier plan.
  async function openModelsFolder() {
    setOpeningFolder(true);
    try {
      const data = await apiFetch('/api/system/open-models-folder', { method: 'POST', body: {} });
      if (data?.ok) {
        updateStatus(`Dossier ouvert : ${data.path}`);
      } else if (data?.mode === 'session0') {
        // Aucune session interactive : on fournit le raccourci .url.
        downloadModelsFolderShortcut();
        updateStatus("Aucune session interactive détectée : le raccourci « Dossier-modeles-LIA-X.url » a été téléchargé — double-cliquez-le pour ouvrir le dossier.");
      } else {
        downloadModelsFolderShortcut();
        updateStatus(`Ouverture impossible (${data?.message || 'raison inconnue'}) — raccourci .url téléchargé.`);
      }
      return data;
    } catch (err) {
      downloadModelsFolderShortcut();
      updateStatus(`Ouverture impossible : ${err.message} — raccourci .url téléchargé.`);
      return null;
    } finally {
      setOpeningFolder(false);
    }
  }

  // Télécharge le raccourci Windows pointant vers le dossier des modèles.
  function downloadModelsFolderShortcut() {
    const link = document.createElement('a');
    link.href = `${apiBase}/api/system/models-folder-shortcut`;
    link.download = 'Dossier-modeles-LIA-X.url';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function refreshLoadedModels(silent = false) {
    try {
      const data = await apiFetch('/api/models');
      setLoadedModels(Array.isArray(data.models) ? data.models : []);
    } catch (err) {
      setLoadedModels([]);
      if (!silent) updateStatus(`Impossible de lire les modèles chargés : ${err.message}`);
    }
  }

  async function refreshActiveModel(silent = false) {
    try {
      const data = await apiFetch('/api/models/active');
      setActiveModel(data.active_model || '');
    } catch (err) {
      setActiveModel('');
      if (!silent) updateStatus(`Impossible de lire le modèle principal : ${err.message}`);
    }
  }

  async function refreshEmbeddingModel(silent = false) {
    try {
      const data = await apiFetch('/api/embedding-model');
      setEmbeddingModel(data.embedding_model || '');
    } catch (err) {
      setEmbeddingModel('');
      if (!silent) updateStatus(`Impossible de lire le modèle d'embedding : ${err.message}`);
    }
  }

  async function refreshModelsState(silent = false) {
    await Promise.all([refreshLoadedModels(silent), refreshActiveModel(silent)]);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Progression de chargement : polling de /api/models/load-progress ──────
  // Pendant un load/select, le controller est occupé (chargement GGUF de
  // plusieurs Go) : on interroge le server qui lit le state disque + sonde
  // le port llama-server pour donner une étape temps réel à l'utilisateur.
  const LOAD_STAGES = ['parsing', 'spawning', 'warmup', 'ready'];
  function stopLoadProgressPolling() {
    if (loadProgressTimerRef.current) {
      clearInterval(loadProgressTimerRef.current);
      loadProgressTimerRef.current = null;
    }
  }
  function startLoadProgressPolling(modelName) {
    stopLoadProgressPolling();
    if (!modelName) return;
    const model = String(modelName);
    setLoadProgress({ model, stage: 'parsing', error: null });
    const poll = async () => {
      try {
        const data = await apiFetch(`/api/models/load-progress?model=${encodeURIComponent(model)}`);
        if (!data || data.model !== model) return;
        setLoadProgress((prev) => (prev && prev.model === model ? { ...prev, ...data } : prev));
        if (data.stage === 'ready' || data.error) {
          stopLoadProgressPolling();
          delay(2500).then(() => setLoadProgress((prev) => (prev?.model === model ? null : prev)));
        }
      } catch { /* controller occupé : on retentera au prochain tick */ }
    };
    poll();
    loadProgressTimerRef.current = setInterval(poll, 1500);
    // Sécurité : arrêt du polling après 10 min max.
    setTimeout(() => { if (loadProgressTimerRef.current) stopLoadProgressPolling(); }, 600000);
  }

  // ── Réconciliation après un échec de chargement ───────────────────────────
  // Le contrôleur est mono-thread et peut poursuivre le démarrage en
  // arrière-plan : après un timeout ou une 502, llama-server finit souvent par
  // démarrer correctement une trentaine de secondes plus tard. Or le rafraîchissement
  // post-erreur, lui, s'exécute à l'instant exact de l'échec, donc trop tôt,
  // et le bloc finally arrête le polling de progression.
  // Résultat observé : l'UI restait figée sur « non chargé » alors que le
  // modèle était bel et bien chargé, et il fallait recharger la page.
  //
  // On réinterroge donc périodiquement quelques dizaines de secondes, et on
  // s'arrête dès que le modèle apparaît chargé. Sans effet si l'échec est
  // réel : on épuise juste les tentatives.
  function reconcileAfterFailedAction(modelName) {
    const model = String(modelName || '');
    if (!model) return;

    const MAX_ATTEMPTS = 24;   // ~2 min à 5 s d'intervalle
    let attempts = 0;

    const tick = async () => {
      attempts += 1;
      try {
        await refreshAllModelState({ silent: true });
        const row = buildRows().find((item) => item.name === model);
        if (row?.loaded) {
          updateStatus(`${model} : chargé (démarrage rattrapé après échec).`);
          return;
        }
      } catch {
        /* le contrôleur peut être occupé : on retentera au tour suivant */
      }
      if (attempts < MAX_ATTEMPTS) {
        setTimeout(tick, 5000);
      }
    };

    setTimeout(tick, 5000);
  }

  async function performAction(modelName, actionType, callback) {
    if (loading || pendingAction) return;
    setLoading(true);
    setPendingAction({ model: modelName, type: actionType });
    if (actionType === 'chargement' || actionType === 'activation') {
      startLoadProgressPolling(modelName);
    }
    updateStatus(`${modelName} : ${actionType}...`);
    try {
      const result = await callback();
      log('action', actionType, modelName, result);
      await delay(250);
      await refreshModelsState(true);
      await refreshAllModelState({ silent: true });
    
      // Clear fetch cache to prevent stale state on next actions
      if ('caches' in window) {
        try {
          const cacheNames = await caches.keys();
          for (const name of cacheNames) {
            await caches.delete(name);
          }
        } catch (e) { /* ignore cache errors */ }
      }
    
      updateStatus(`${modelName} : ${actionType} terminé.`);
      return result;
    } catch (err) {
      console.error('[App] action error', actionType, modelName, err);
      updateStatus(`${modelName} : échec ${actionType} — ${err.message}`);
      try {
        await refreshAllModelState({ silent: true });
      } catch (refreshErr) {
        console.warn('[App] post-error refresh failed', refreshErr);
      }
      // Ce rafraîchissement est trop tôt : le chargement peut être encore en
      // cours côté contrôleur. On lance une réconciliation qui réinterroge
      // l'état plusieurs fois, pour ne pas laisser l'UI afficher « non chargé »
      // alors que le modèle est effectivement monté.
      if (actionType === 'chargement' || actionType === 'activation') {
        reconcileAfterFailedAction(modelName);
      }
      return null;
    } finally {
      stopLoadProgressPolling();
      setPendingAction(null);
      setLoading(false);
    }
  }

  async function handleLoadFile(modelName) {
    if (!modelName) return;
    const row = buildRows().find((item) => item.name === modelName);
    const requestedContext = getRequestedContextForRow(row);
    const payload = {
      model: modelName,
      context: requestedContext,
    };
    if (recommendedRuntime?.gpu_layers !== undefined && recommendedRuntime?.gpu_layers !== null) {
      payload.gpu_layers = recommendedRuntime.gpu_layers;
    }
    log('load payload', payload);
    const result = await performAction(modelName, 'chargement', async () => apiFetch('/api/models/load', {
      method: 'POST',
      body: payload,
    }));

    if (result) {
      setModelContextNeedsReload((current) => ({
        ...current,
        [modelName]: false,
      }));
    }

    return result;
  }

  async function handleSelectLoaded(modelName) {
    if (!modelName) return;
    if (modelName === activeModel) {
      updateStatus(`${modelName} est déjà principal.`);
      return;
    }

    const row = buildRows().find((r) => r.name === modelName);
    if (!row) {
      updateStatus(`Impossible de trouver ${modelName}.`);
      return null;
    }

    // Si le modèle n'est pas chargé, charge-le d'abord puis promeut
    if (!row.loaded) {
      await handleLoadFile(modelName);
    }

    // Si le contexte ou les GPU layers ont changé pour un modèle déjà chargé,
    // recharge-le avant d'en faire le principal.
    const needsReload = row.loaded && modelContextNeedsReload[row.name];
    if (needsReload) {
      await handleUnloadModel(modelName);
      await handleLoadFile(modelName);
    }

    const updatedRow = buildRows().find((r) => r.name === modelName);
    return performAction(modelName, 'activation', async () => {
      const payload = { model: modelName };
      if (updatedRow) {
        const requestedContext = getRequestedContextForRow(updatedRow);
        if (requestedContext !== null) payload.context = requestedContext;
      }
      if (recommendedRuntime?.gpu_layers !== undefined && recommendedRuntime?.gpu_layers !== null) {
        payload.gpu_layers = recommendedRuntime.gpu_layers;
      }
      log('select payload', payload);
      const data = await apiFetch('/api/models/select', { method: 'POST', body: payload });
      setActiveModel(data.active_model || modelName);
      return data;
    });
  }

  async function handleUnloadModel(modelName) {
    if (!modelName) return;
    const result = await performAction(modelName, 'déchargement', async () => apiFetch('/api/models/unload', { method: 'POST', body: { model: modelName } }));
    if (result) {
      setModelContextNeedsReload((current) => ({
        ...current,
        [modelName]: false,
      }));
    }
    return result;
  }

  async function handleReloadModel(modelName) {
    if (!modelName) return;
    const row = buildRows().find((item) => item.name === modelName);
    if (!row || !row.loaded) {
      updateStatus(`${modelName} n'est pas chargé.`);
      return null;
    }

    updateStatus(`${modelName} : rechargement pour appliquer le nouveau contexte...`);
    await handleUnloadModel(modelName);
    const result = await handleLoadFile(modelName);
    return result;
  }

  async function handleDeleteFile(filename) {
    if (!filename || !window.confirm(`Supprimer définitivement ${filename} ?`)) return;
    return performAction(filename, 'suppression', async () => apiFetch(`/api/models/files/${encodeURIComponent(filename)}`, { method: 'DELETE' }));
  }

  async function handleSetEmbeddingModel(modelName) {
    if (!modelName) return;
    setEmbeddingModelLoading(true);
    try {
      await apiFetch('/api/embedding-model', {
        method: 'POST',
        body: JSON.stringify({ model: modelName }),
      });
      setEmbeddingModel(modelName);
      updateStatus(`Modèle d'embedding défini : ${modelName}`);
    } catch (err) {
      updateStatus(`Impossible de définir le modèle d'embedding : ${err.message}`);
    } finally {
      setEmbeddingModelLoading(false);
    }
  }

  async function handleUnsetEmbeddingModel() {
    setEmbeddingModelLoading(true);
    try {
      await apiFetch('/api/embedding-model', {
        method: 'POST',
        body: JSON.stringify({ model: '' }),
      });
      setEmbeddingModel('');
      updateStatus('Modèle d\'embedding désélectionné.');
    } catch (err) {
      updateStatus(`Impossible de désélectionner le modèle d'embedding : ${err.message}`);
    } finally {
      setEmbeddingModelLoading(false);
    }
  }

  async function handleOpenModelDetails(modelName) {
    if (!modelName) return;
    setModelDetailsLoading(true);
    try {
      const data = await apiFetch(`/api/models/details/${encodeURIComponent(modelName)}`);
      setModelDetails(data);
    } catch (error) {
      updateStatus(`Impossible de charger les détails : ${error.message}`);
    } finally {
      setModelDetailsLoading(false);
    }
  }

  // Rafraîchit l'état des téléchargements (jobs serveur : progression réelle).
  async function refreshDownloads() {
    try {
      const data = await apiFetch('/api/models/downloads');
      const list = Array.isArray(data?.downloads) ? data.downloads : [];
      downloadsRef.current = list;
      setDownloads(list);
      return list;
    } catch {
      // UI momentanément indisponible : on retentera au prochain tick.
      return null;
    }
  }

  // Lance un téléchargement EN TÂCHE DE FOND : la requête HTTP répond en
  // quelques millisecondes, la page reste utilisable et la progression est
  // affichée dans le panneau « Téléchargements ».
  async function startBackgroundDownload({ autoLoad = false } = {}) {
    const url = normalizeUrl(huggingfaceUrl);
    const ollama = normalizeUrl(ollamaName);
    const localName = String(hfModelName || '').trim();

    if (!url && !ollama) {
      updateStatus('Entrez un lien Hugging Face ou une référence Ollama.');
      return;
    }
    if (ollama && !localName) {
      updateStatus('Un « Nom local » est requis pour un import Ollama.');
      return;
    }

    const body = ollama
      ? { ollama_name: ollama, name: localName }
      : { url, name: localName || undefined };

    requestNotificationPermission();

    try {
      const started = await apiFetch('/api/models/download', { method: 'POST', body });
      if (autoLoad && started?.model) {
        autoLoadRef.current.add(started.model);
      }
      updateStatus(`Téléchargement démarré en arrière-plan : ${started?.filename || localName || url}`);
      setHuggingfaceUrl('');
      setOllamaName('');
      setHfModelName('');
      await refreshDownloads();
    } catch (err) {
      updateStatus(`Impossible de démarrer le téléchargement — ${err.message}`);
    }
  }

  async function handlePauseDownload(job) {
    if (!job?.model) return;
    try {
      await apiFetch('/api/models/download/pause', { method: 'POST', body: { model: job.model } });
      updateStatus(`Téléchargement mis en pause : ${job.filename || job.model}`);
      await refreshDownloads();
    } catch (err) {
      updateStatus(`Impossible de mettre en pause — ${err.message}`);
    }
  }

  async function handleResumeDownload(job) {
    if (!job?.model) return;
    try {
      await apiFetch('/api/models/download/resume', { method: 'POST', body: { model: job.model } });
      updateStatus(`Téléchargement repris : ${job.filename || job.model}`);
      await refreshDownloads();
    } catch (err) {
      updateStatus(`Impossible de reprendre — ${err.message}`);
    }
  }

  async function handleCancelDownload(job) {
    if (!job?.model) return;
    try {
      await apiFetch('/api/models/download/cancel', { method: 'POST', body: { model: job.model } });
      updateStatus(`Téléchargement annulé : ${job.filename || job.model}`);
      await refreshDownloads();
    } catch (err) {
      updateStatus(`Annulation impossible — ${err.message}`);
    }
  }

  async function handleDismissDownload(job) {
    if (!job?.model) return;
    try {
      await apiFetch(`/api/models/download/${encodeURIComponent(job.model)}`, { method: 'DELETE' });
      await refreshDownloads();
    } catch (err) {
      updateStatus(`Impossible de retirer ce téléchargement — ${err.message}`);
    }
  }

  async function handleLoadDownloaded(modelName) {
    if (!modelName) return;
    await refreshAllModelState({ silent: true }).catch(() => {});
    await handleLoadFile(modelName);
  }

  async function handleDownloadUrl() {
    await startBackgroundDownload({ autoLoad: false });
  }

  async function handleDownloadAndLoadUrl() {
    // Téléchargement en tâche de fond puis chargement automatique dès qu'il est
    // terminé (notification + progression réelle dans le panneau).
    await startBackgroundDownload({ autoLoad: true });
  }

  const modelRows = useMemo(() => {
    const rows = new Map();
    availableFiles.forEach((file) => {
      const name = String(file?.name || '');
      if (!name) return;
      const rawGpuLayers = Number(file.gpu_layers);
      rows.set(name, {
        name,
        filename: file.filename || `${name}.gguf`,
        loaded: false,
        active: false,
        partial: false,
        partialJob: null,
        diskSize: file.size ?? null,
        modifiedAt: file.modified_at ?? null,
        vramSize: null,
        vramSource: null,
        expiresAt: null,
        contextLength: normalizeContextValue(file.context_length),
        runtimeContextLength: null,
        gpuLayers: Number.isFinite(rawGpuLayers) ? rawGpuLayers : null,
      });
    });
    loadedModels.forEach((item) => {
      const name = String(item?.model || '');
      if (!name) return;

      // Ligne « téléchargement partiel » : le fichier final n'existe pas encore,
      // mais la ligne doit rester dans la table avec sa progression et ses
      // boutons Pause / Reprendre / Retirer (demandé par l'utilisateur).
      if (item.partial) {
        const existingPartial = rows.get(name) || {};
        rows.set(name, {
          ...existingPartial,
          name,
          filename: item.filename || existingPartial.filename || `${name}.gguf`,
          partial: true,
          partialJob: item.partial_job || null,
          loaded: false,
          active: false,
          vramSize: null,
          vramSource: null,
          modifiedAt: item.partial_job?.updated_at ?? existingPartial.modifiedAt ?? null,
        });
        return;
      }

      const itemContext = normalizeContextValue(item.context_length) ?? normalizeContextValue(item.context);
      const existing = rows.get(name) || {};
      rows.set(name, {
        name,
        filename: item.filename || existing.filename || `${name}.gguf`,
        loaded: true,
        active: name === activeModel,
        partial: false,
        partialJob: null,
        diskSize: existing.diskSize ?? null,
        modifiedAt: existing.modifiedAt ?? null,
        // VRAM mesurée sur le processus llama-server.exe par le controller hôte
        // (compteurs Windows), sinon estimation éventuelle du state.
        vramSize: item.size_vram ?? null,
        vramSource: item.size_vram_source ?? null,
        // Pic de mémoire observé sur le processus : sur un backend GPU à veille
        // (llama-server « sleep »), la VRAM courante retombe à ~0 alors que le
        // pic reflète ce que le modèle a réellement occupé une fois chargé.
        vramPeak: item.peak_process_memory_bytes ?? null,
        expiresAt: item.expires_at ?? null,
        contextLength: existing.contextLength ?? itemContext ?? null,
        runtimeContextLength: itemContext ?? existing.runtimeContextLength ?? null,
        gpuLayers: existing.gpuLayers ?? null,
      });
    });
    return sortRows(Array.from(rows.values()));
  }, [availableFiles, loadedModels, activeModel, sortColumn, sortDirection]);

  function handleSortClick(column) {
    if (sortColumn === column) {
      setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  }

  const emptyState = modelRows.length === 0;

  return {
    // Saisie et dossier des modeles
    huggingfaceUrl, setHuggingfaceUrl,
    ollamaName, setOllamaName,
    hfModelName, setHfModelName,
    modelsHostDir, openingFolder, setOpeningFolder,
    hostPathCopied, setHostPathCopied,
    openModelsFolder,
    apiCopied, setApiCopied,
    // Table des modeles
    modelRows, emptyState,
    activeModel, availableFiles, loadedModels, embeddingModel, embeddingModelLoading,
    sortColumn, sortDirection, handleSortClick,
    modelContextNeedsReload, recommendedRuntime,
    // Formatage
    formatBytes, formatShortDate, vramSourceLabel, vramSourceBadge,
    getSliderMinContext, getSliderMaxContext,
    getRequestedContextForRow, handleContextSliderChange, handleContextSliderCommit,
    // Actions sur les modeles
    loading, pendingAction,
    handleLoadFile, handleUnloadModel, handleSelectLoaded, handleReloadModel, handleTogglePin, pinnedModels, toFilename,
    handleDeleteFile, handleOpenModelDetails,
    handleSetEmbeddingModel, handleUnsetEmbeddingModel,
    handleDownloadUrl, handleDownloadAndLoadUrl,
    // Modales
    setShowRecommendedRuntimeModal, showRecommendedRuntimeModal,
    modelDetails, modelDetailsLoading, setModelDetails,
    hardwareProfile, hardwareDiagnostic, hardwareRescanLoading, rescanHardware,
    // Telechargements (le panneau est rendu par le shell, sur toutes les pages)
    downloads, refreshDownloads,
    handlePauseDownload, handleResumeDownload, handleCancelDownload,
    handleDismissDownload, handleLoadDownloaded,
    // Progression de chargement, barree dans le shell
    loadProgress,
    // Runtime et controleur
    version, versionChecked, setVersion,
    controllerHealth, setControllerHealth, controllerLoading,
    fetchControllerHealth, handleRestartController,
    // Messages systeme
    statusToast, updateStatus,
    refreshAllModelState,
    loadProgressTimerRef, setLoadProgress,
    apiBaseUrl,
  };
}
