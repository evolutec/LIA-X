import { useEffect, useState } from "react";

// VITE_API_BASE_URL="" → appels relatifs (même origin que la page)
// Utilise ?? (nullish) et non || pour que la chaîne vide soit acceptée
const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

function App() {
  const [huggingfaceUrl, setHuggingfaceUrl] = useState("");
  const [ollamaName, setOllamaName] = useState("");
  const [availableFiles, setAvailableFiles] = useState([]);
  const [loadedModels, setLoadedModels] = useState([]);
  const [activeModel, setActiveModel] = useState("");
  const [status, setStatus] = useState("");
  const [version, setVersion] = useState(null);
  const [statusInfo, setStatusInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [hfModelName, setHfModelName] = useState("");
  const [pendingModelAction, setPendingModelAction] = useState(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [selectedModelDetails, setSelectedModelDetails] = useState(null);

  useEffect(() => {
    refreshAllModelState();

    return undefined;
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!loading && !pendingModelAction) {
        refreshAllModelState({ silent: true });
      }
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [loading, pendingModelAction]);

  async function refreshAllModelState(options = {}) {
    const { silent = false } = options;
    await Promise.all([
      refreshStatus(silent),
      refreshAvailableFiles(silent),
      refreshLoadedModels(silent),
      refreshStatusInfo(silent),
      refreshActiveModel(silent),
    ]);
    setLastSyncedAt(Date.now());
  }

  function normalizeUrl(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function getAvailableModelName(file) {
    return String(file?.name ?? "");
  }

  function getLoadedModelName(model) {
    return String(model?.model ?? "");
  }

  function isPendingModel(name, action = null) {
    if (!pendingModelAction) {
      return false;
    }
    if (pendingModelAction.name !== name) {
      return false;
    }
    return action ? pendingModelAction.type === action : true;
  }

  function removeAvailableModel(list, name) {
    return list.filter((item) => getAvailableModelName(item) !== name);
  }

  function removeLoadedModel(list, name) {
    return list.filter((item) => getLoadedModelName(item) !== name);
  }

  function prependAvailableModel(list, name) {
    return [
      {
        name,
        size: 0,
        modified_at: Math.floor(Date.now() / 1000),
        optimistic: true,
      },
      ...removeAvailableModel(list, name),
    ];
  }

  function prependLoadedModel(list, name) {
    return [
      {
        id: name,
        model: name,
        size_vram: 0,
        expires_at: null,
        optimistic: true,
      },
      ...removeLoadedModel(list, name),
    ];
  }

  function syncRunningModels(modelName, shouldBeRunning) {
    setStatusInfo((current) => {
      if (!current) {
        return current;
      }

      const currentModels = Array.isArray(current.models) ? current.models : [];
      const remainingModels = currentModels.filter((item) => String(item.model) !== modelName);
      const nextModels = shouldBeRunning
        ? [{ model: modelName, device: current.gpu?.device ?? "—", approx_memory_bytes: 0, optimistic: true }, ...remainingModels]
        : remainingModels;

      return {
        ...current,
        running_models: nextModels.length,
        models: nextModels,
      };
    });
  }

  function formatSyncTime(timestamp) {
    if (!timestamp) {
      return "Synchronisation initiale…";
    }
    return `Synchronisé à ${new Date(timestamp).toLocaleTimeString("fr-FR")}`;
  }

  function deriveModelNameFromUrl(value) {
    const normalized = normalizeUrl(value);
    if (!normalized) {
      return "";
    }
    try {
      const pathname = new URL(normalized).pathname;
      const filename = decodeURIComponent(pathname.split("/").pop() || "");
      return filename.replace(/\.gguf(?:\..*)?$/i, "");
    } catch {
      return "";
    }
  }

  function isHuggingFaceGgufUrl(value) {
    const normalized = normalizeUrl(value);
    return /^https?:\/\/(www\.)?huggingface\.co\//i.test(normalized)
      && /\/resolve\/.+\.gguf(?:\?.*)?$/i.test(normalized);
  }

  function getHuggingFaceImportDraft() {
    const directUrl = normalizeUrl(huggingfaceUrl);
    const fallbackUrl = isHuggingFaceGgufUrl(ollamaName) ? normalizeUrl(ollamaName) : "";
    const url = directUrl || fallbackUrl;
    const name = normalizeUrl(hfModelName) || deriveModelNameFromUrl(url);
    return { url, name };
  }

  async function refreshStatus(silent = false) {
    try {
      const res = await fetch(`${apiBase}/api/version`);
      if (!res.ok) throw new Error(res.statusText);
      setVersion(await res.json());
    } catch (err) {
      setVersion(null);
      if (!silent) {
        setStatus(`Backend unavailable: ${extractErrorMessage(err.message || err)}`);
      }
    }
  }

  function extractErrorMessage(detail) {
    if (typeof detail === "string") {
      return detail;
    }
    if (Array.isArray(detail)) {
      return detail
        .map((item) => {
          if (typeof item === "string") return item;
          if (item?.msg) return item.msg;
          if (item?.detail) return item.detail;
          return JSON.stringify(item);
        })
        .join("; ");
    }
    if (detail && typeof detail === "object") {
      if (detail.msg) return detail.msg;
      if (detail.detail) return detail.detail;
      return JSON.stringify(detail);
    }
    return String(detail);
  }

  function formatModelValue(value) {
    if (value == null || value === "") {
      return "-";
    }
    if (typeof value === "object") {
      if (value.n_ctx != null) return String(value.n_ctx);
      if (value.value != null) return String(value.value);
      return JSON.stringify(value);
    }
    return String(value);
  }

  function formatBytes(bytes) {
    if (bytes == null || bytes === "") {
      return "-";
    }
    const value = Number(bytes);
    if (Number.isNaN(value)) {
      return String(bytes);
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let index = 0;
    let amount = value;
    while (amount >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index += 1;
    }
    return `${amount.toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
  }

  async function refreshAvailableFiles(silent = false) {
    try {
      const res = await fetch(`${apiBase}/api/models/available`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setAvailableFiles(Array.isArray(data.files) ? data.files : []);
    } catch (err) {
      setAvailableFiles([]);
      if (!silent) {
        setStatus(`Unable to list local models: ${extractErrorMessage(err.message || err)}`);
      }
    }
  }

  async function refreshLoadedModels(silent = false) {
    try {
      const res = await fetch(`${apiBase}/api/models`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setLoadedModels(Array.isArray(data.models) ? data.models : []);
    } catch (err) {
      setLoadedModels([]);
      if (!silent) {
        setStatus(`Unable to list loaded models: ${extractErrorMessage(err.message || err)}`);
      }
    }
  }

  async function refreshStatusInfo(silent = false) {
    try {
      const res = await fetch(`${apiBase}/api/models/status`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setStatusInfo(data);
    } catch (err) {
      setStatusInfo(null);
      if (!silent) {
        setStatus(`Unable to fetch model status: ${extractErrorMessage(err.message || err)}`);
      }
    }
  }

  async function refreshActiveModel(silent = false) {
    try {
      const res = await fetch(`${apiBase}/api/models/active`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setActiveModel(data.active_model || "");
    } catch (err) {
      setActiveModel("");
      if (!silent) {
        setStatus(`Unable to resolve active model: ${extractErrorMessage(err.message || err)}`);
      }
    }
  }

  async function handleDownloadUrl() {
    const hfDraft = getHuggingFaceImportDraft();
    if (hfDraft.url) {
      await importHuggingFaceModel(false, hfDraft);
      return;
    }

    const payload = {};
    if (ollamaName.trim()) {
      payload.ollama_name = ollamaName.trim();
    } else if (huggingfaceUrl.trim()) {
      payload.url = huggingfaceUrl.trim();
    } else {
      setStatus("Entrez un nom Ollama ou une URL Hugging Face.");
      return;
    }
    setLoading(true);
    setDownloadProgress(0);
    setStatus(`Téléchargement du modèle...`);
    const progressInterval = setInterval(() => {
      setDownloadProgress(prev => Math.min(prev + 10, 90));
    }, 500);
    try {
      const res = await fetch(`${apiBase}/api/models/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      setDownloadProgress(100);
      setStatus(`Modèle téléchargé : ${data.filename}`);
      setHuggingfaceUrl("");
      setOllamaName("");
      await refreshAllModelState({ silent: true });
    } catch (err) {
      setStatus(`Échec du téléchargement : ${extractErrorMessage(err.message || err)}`);
    } finally {
      clearInterval(progressInterval);
      setLoading(false);
      setTimeout(() => setDownloadProgress(0), 1000);
    }
  }

  async function handleDownloadAndLoadUrl() {
    const hfDraft = getHuggingFaceImportDraft();
    if (hfDraft.url) {
      await importHuggingFaceModel(true, hfDraft);
      return;
    }

    const payload = {};
    if (ollamaName.trim()) {
      payload.ollama_name = ollamaName.trim();
    } else if (huggingfaceUrl.trim()) {
      payload.url = huggingfaceUrl.trim();
    } else {
      setStatus("Entrez un nom Ollama ou une URL Hugging Face.");
      return;
    }
    setLoading(true);
    setDownloadProgress(0);
    setStatus(`Téléchargement et chargement du modèle...`);
    const progressInterval = setInterval(() => {
      setDownloadProgress(prev => Math.min(prev + 10, 90));
    }, 500);
    try {
      const res = await fetch(`${apiBase}/api/models/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      const downloadedName = data.filename;
      setDownloadProgress(95);

      const loadRes = await fetch(`${apiBase}/api/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: downloadedName }),
      });
      const loadData = await loadRes.json();
      if (!loadRes.ok) throw new Error(extractErrorMessage(loadData.detail || loadRes.statusText));
      setDownloadProgress(100);
      setStatus(`Modèle téléchargé et chargé : ${downloadedName}`);
      setHuggingfaceUrl("");
      setOllamaName("");
      await refreshAllModelState({ silent: true });
    } catch (err) {
      setStatus(`Échec du téléchargement/chargement : ${extractErrorMessage(err.message || err)}`);
    } finally {
      clearInterval(progressInterval);
      setLoading(false);
      setTimeout(() => setDownloadProgress(0), 1000);
    }
  }

  async function handleLoadFile(filename) {
    if (loading || pendingModelAction) {
      return;
    }

    const modelName = String(filename);
    const previousAvailableFiles = availableFiles;
    const previousLoadedModels = loadedModels;
    const previousStatusInfo = statusInfo;

    setPendingModelAction({ name: modelName, type: "load" });
    setAvailableFiles((current) => removeAvailableModel(current, modelName));
    setLoadedModels((current) => prependLoadedModel(current, modelName));
    syncRunningModels(modelName, true);
    setStatus(`Chargement en mémoire de ${modelName}...`);
    try {
      const res = await fetch(`${apiBase}/api/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      setStatus(`Modèle chargé : ${data.model}${data.context_applied ? ` · contexte ${formatCount(data.context_applied)}` : ""}`);
      await refreshAllModelState({ silent: true });
    } catch (err) {
      setAvailableFiles(previousAvailableFiles);
      setLoadedModels(previousLoadedModels);
      setStatusInfo(previousStatusInfo);
      setStatus(`Échec du chargement : ${extractErrorMessage(err.message || err)}`);
    } finally {
      setPendingModelAction(null);
    }
  }

  async function handleSelectLoaded(model) {
    if (loading || pendingModelAction) {
      return;
    }

    const modelName = String(model);
    const previousActiveModel = activeModel;

    setPendingModelAction({ name: modelName, type: "select" });
    setActiveModel(modelName);
    setStatus(`Activation du modèle ${modelName}...`);
    try {
      const res = await fetch(`${apiBase}/api/models/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      setActiveModel(data.active_model || "");
      setStatus(`Modèle actif : ${data.active_model}${data.context_applied ? ` · contexte ${formatCount(data.context_applied)}` : ""}`);
      await refreshAllModelState({ silent: true });
    } catch (err) {
      setActiveModel(previousActiveModel);
      setStatus(`Échec de la sélection : ${extractErrorMessage(err.message || err)}`);
    } finally {
      setPendingModelAction(null);
    }
  }

  async function handleUnloadModel(model) {
    if (loading || pendingModelAction) {
      return;
    }

    const modelName = String(model);
    const previousAvailableFiles = availableFiles;
    const previousLoadedModels = loadedModels;
    const previousStatusInfo = statusInfo;
    const previousActiveModel = activeModel;

    setPendingModelAction({ name: modelName, type: "unload" });
    setLoadedModels((current) => removeLoadedModel(current, modelName));
    setAvailableFiles((current) => prependAvailableModel(current, modelName));
    syncRunningModels(modelName, false);
    setActiveModel((current) => (current === modelName ? "" : current));
    setStatus(`Déchargement du modèle ${modelName}...`);
    try {
      const res = await fetch(`${apiBase}/api/models/unload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      setStatus(`Modèle déchargé : ${data.model}`);
      setActiveModel((current) => (current === data.model ? "" : current));
      await refreshAllModelState({ silent: true });
    } catch (err) {
      setAvailableFiles(previousAvailableFiles);
      setLoadedModels(previousLoadedModels);
      setStatusInfo(previousStatusInfo);
      setActiveModel(previousActiveModel);
      setStatus(`Échec du déchargement : ${extractErrorMessage(err.message || err)}`);
    } finally {
      setPendingModelAction(null);
    }
  }

  async function handleDeleteFile(filename) {
    if (!confirm(`Êtes-vous sûr de vouloir supprimer le modèle "${filename}" ? Cette action est irréversible.`)) {
      return;
    }
    if (loading || pendingModelAction) {
      return;
    }

    const modelName = String(filename);
    const previousAvailableFiles = availableFiles;

    setPendingModelAction({ name: modelName, type: "delete" });
    setAvailableFiles((current) => removeAvailableModel(current, modelName));
    setStatus(`Suppression du modèle ${modelName}...`);
    try {
      const res = await fetch(`${apiBase}/api/models/files/${encodeURIComponent(modelName)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));
      setStatus(`Modèle supprimé : ${data.filename}`);
      await refreshAllModelState({ silent: true });
    } catch (err) {
      setAvailableFiles(previousAvailableFiles);
      setStatus(`Échec de la suppression : ${extractErrorMessage(err.message || err)}`);
    } finally {
      setPendingModelAction(null);
    }
  }

  function handleHFUrlChange(url) {
    setHuggingfaceUrl(url);
    // Auto-dériver le nom du modèle depuis l'URL si le champ est vide
    if (url) {
      const derived = deriveModelNameFromUrl(url);
      if (derived) setHfModelName(prev => prev || derived);
    }
  }

  async function importHuggingFaceModel(andLoad, draft = getHuggingFaceImportDraft()) {
    const importUrl = normalizeUrl(draft?.url);
    const importName = normalizeUrl(draft?.name) || deriveModelNameFromUrl(importUrl);

    if (!importUrl) {
      setStatus("Entrez une URL HuggingFace (.gguf).");
      return;
    }
    if (!isHuggingFaceGgufUrl(importUrl)) {
      setStatus("L'URL HuggingFace doit pointer vers un fichier .gguf via /resolve/.");
      return;
    }
    if (!importName) {
      setStatus("Entrez un nom pour le modèle.");
      return;
    }

    setLoading(true);
    setDownloadProgress(0);
    setStatus("Import GGUF depuis HuggingFace (peut prendre plusieurs minutes selon la taille)...");
    const progressInterval = setInterval(() => {
      setDownloadProgress(prev => Math.min(prev + 2, 90));
    }, 3000);

    try {
      const res = await fetch(`${apiBase}/api/models/import-hf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: importUrl, name: importName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(extractErrorMessage(data.detail || res.statusText));

      const resolvedModelName = data.filename || importName;
      setDownloadProgress(andLoad ? 95 : 100);
      if (andLoad) {
        const loadRes = await fetch(`${apiBase}/api/models/load`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: resolvedModelName }),
        });
        const loadData = await loadRes.json();
        if (!loadRes.ok) throw new Error(extractErrorMessage(loadData.detail || loadRes.statusText));
        setDownloadProgress(100);
        setStatus(`Modèle importé et chargé : ${resolvedModelName}`);
        await refreshAllModelState({ silent: true });
      } else {
        setStatus(`Modèle importé : ${resolvedModelName}`);
        await refreshAllModelState({ silent: true });
      }

      setHuggingfaceUrl("");
      setHfModelName("");
      setOllamaName("");
    } catch (e) {
      setStatus(`Échec de l'import HF : ${extractErrorMessage(e.message || e)}`);
    } finally {
      clearInterval(progressInterval);
      setLoading(false);
      setTimeout(() => setDownloadProgress(0), 1000);
    }
  }

  async function handleImportHF(andLoad) {
    await importHuggingFaceModel(andLoad);
  }

  function formatShortDate(value) {
    if (!value) {
      return "—";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "—";
    }
    return date.toLocaleString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatUnixDate(value) {
    const timestamp = Number(value);
    if (!timestamp) {
      return "—";
    }
    return formatShortDate(timestamp * 1000);
  }

  function formatCount(value) {
    if (value == null || value === "") {
      return "—";
    }

    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return new Intl.NumberFormat("fr-FR").format(numericValue);
    }

    return String(value);
  }

  function formatTensorShape(dimensions) {
    if (!Array.isArray(dimensions) || dimensions.length === 0) {
      return "[]";
    }

    return `[${dimensions.map((dimension) => formatCount(dimension)).join(", ")}]`;
  }

  function buildTensorGroups(tensors) {
    const groups = new Map();

    tensors.forEach((tensor) => {
      const blockMatch = /^blk\.(\d+)(?:\.|$)/.exec(tensor.name);
      const groupKey = blockMatch ? `blk.${blockMatch[1]}` : tensor.name.split(".")[0];
      const group = groups.get(groupKey) || { name: groupKey, tensors: [] };
      group.tensors.push(tensor);
      groups.set(groupKey, group);
    });

    return Array.from(groups.values()).sort((left, right) => {
      const leftBlock = /^blk\.(\d+)$/u.exec(left.name);
      const rightBlock = /^blk\.(\d+)$/u.exec(right.name);

      if (leftBlock && rightBlock) {
        return Number(leftBlock[1]) - Number(rightBlock[1]);
      }

      if (leftBlock) {
        return 1;
      }

      if (rightBlock) {
        return -1;
      }

      return left.name.localeCompare(right.name, "fr", { sensitivity: "base" });
    });
  }

  async function handleOpenModelDetails(modelName) {
    setDetailsOpen(true);
    setDetailsLoading(true);
    setDetailsError("");
    setSelectedModelDetails(null);

    try {
      const res = await fetch(`${apiBase}/api/models/details/${encodeURIComponent(modelName)}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(extractErrorMessage(data.detail || res.statusText));
      }
      setSelectedModelDetails(data);
    } catch (err) {
      setDetailsError(extractErrorMessage(err.message || err));
    } finally {
      setDetailsLoading(false);
    }
  }

  function handleCloseModelDetails() {
    setDetailsOpen(false);
    setDetailsLoading(false);
    setDetailsError("");
    setSelectedModelDetails(null);
  }

  const unifiedModelRows = (() => {
    const rows = new Map();

    availableFiles.forEach((file) => {
      const name = getAvailableModelName(file);
      if (!name) {
        return;
      }
      rows.set(name, {
        name,
        diskSize: file.size,
        modifiedAt: file.modified_at,
        vramSize: null,
        expiresAt: null,
        loaded: false,
        active: name === activeModel,
      });
    });

    loadedModels.forEach((item) => {
      const name = getLoadedModelName(item);
      if (!name) {
        return;
      }
      const existing = rows.get(name);
      rows.set(name, {
        name,
        diskSize: existing?.diskSize ?? null,
        modifiedAt: existing?.modifiedAt ?? null,
        vramSize: item.size_vram,
        expiresAt: item.expires_at,
        loaded: true,
        active: name === activeModel,
      });
    });

    return Array.from(rows.values()).sort((left, right) => {
      if (left.active !== right.active) {
        return left.active ? -1 : 1;
      }
      if (left.loaded !== right.loaded) {
        return left.loaded ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "fr", { sensitivity: "base" });
    });
  })();

  const tensorGroups = buildTensorGroups(selectedModelDetails?.gguf?.tensors || []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <img src="/logo.svg" alt="LIA Logo" width="48" height="48" />
          <div>
            <h1 style={{ margin: 0 }}>LIA</h1>
            <p className="hero-subtitle" style={{ margin: 0 }}>LOCAL INTELLIGENT ASSISTANT</p>
          </div>
        </div>
        <div className="backend-badge">
          <span className={`dot ${version ? "" : "offline"}`}></span>
          <span>{version ? `Runtime prêt · ${version.version ?? "llama.cpp"}` : "Runtime hors ligne"}</span>
        </div>
      </header>

      <div className="app-content">
        {status && (
          <div className={`notification ${status.includes("Échec") || status.includes("unavailable") || status.includes("offline") ? "error" : "info"}`}>
            {status}
          </div>
        )}

        <section className="hero-panel">
          <div className="hero-copy">
            <div className="eyebrow">Console locale</div>
            <h2>Charge un GGUF, démarre llama.cpp et expose un endpoint stable aux interfaces web.</h2>
            <p>Le runtime tourne sur Windows, tandis que ce panneau pilote le modèle actif et le proxy OpenAI compatible.</p>
          </div>
        </section>

        <div className="card status-card">
          <div className="card-title">📊 Statut du runtime</div>
          <div className="card-subtitle">{formatSyncTime(lastSyncedAt)}</div>
          <div className="status-grid status-grid-hero">
            <div className="status-item status-item-glow">
              <label>Runtime</label>
              <div className="value">{version?.version ?? "—"}</div>
            </div>
            <div className="status-item">
              <label>Backend</label>
              <div className="value">{version?.device ?? "—"}</div>
            </div>
            <div className="status-item">
              <label>Modèle actif</label>
              <div className="value">{activeModel || "—"}</div>
            </div>
            <div className="status-item">
              <label>Répertoire GGUF</label>
              <div className="value">{version?.model_dir ?? "—"}</div>
            </div>
          </div>
          {statusInfo ? (
            <>
              <div className="card-subtitle section-spacer">Vue synthétique du runtime hôte et du nombre de modèles réellement servis.</div>
              <div className="status-grid status-grid-detail">
                <div className="status-item">
                  <label>Total modèles</label>
                  <div className="value">{statusInfo.total_models}</div>
                </div>
                <div className="status-item">
                  <label>Modèles en mémoire</label>
                  <div className="value">{statusInfo.running_models ?? 0}</div>
                </div>
                <div className="status-item">
                  <label>Proxy exposé</label>
                  <div className="value">lia-local</div>
                </div>
              </div>
              {!(statusInfo.models?.length > 0) ? (
                <div className="empty-state compact-empty-state">Aucun modèle actuellement en mémoire.</div>
              ) : null}
            </>
          ) : (
            <div className="empty-state">Statut non disponible. Utilise Rafraîchir.</div>
          )}
        </div>

        <div className="card download-card">
          <div className="card-title">⬇️ Importer un modèle GGUF</div>
          <div className="card-subtitle">Import direct depuis Hugging Face ou depuis la bibliothèque Ollama, puis copie dans le répertoire local.</div>
          {downloadProgress > 0 && (
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${downloadProgress}%` }}></div>
              <span className="progress-text">{downloadProgress}%</span>
            </div>
          )}
          <div className="download-grid">
            <label className="field-block">
              <span className="field-label">Nom local</span>
              <input
                type="text"
                value={hfModelName}
                onChange={(e) => setHfModelName(e.target.value)}
                placeholder="qwen2.5-1.5b-q4_k_m"
                aria-label="Nom local du modèle"
              />
            </label>
            <label className="field-block">
              <span className="field-label">Lien Hugging Face</span>
              <input
                type="text"
                value={huggingfaceUrl}
                onChange={(e) => handleHFUrlChange(e.target.value)}
                placeholder="https://huggingface.co/...gguf"
                aria-label="URL GGUF HuggingFace"
              />
            </label>
            <label className="field-block download-grid-span">
              <span className="field-label">Référence Ollama Library</span>
              <input
                type="text"
                value={ollamaName}
                onChange={(e) => setOllamaName(e.target.value)}
                placeholder="gemma3n:e4b ou https://ollama.com/library/gemma3n:e4b"
                aria-label="Référence Ollama Library"
              />
            </label>
          </div>
          <p className="hint import-hint-centered">
            Tu peux utiliser un lien GGUF Hugging Face ou un identifiant Ollama Library. Parcourir la bibliothèque : <a href="https://ollama.com/library" target="_blank" rel="noopener noreferrer">ollama.com/library</a>
          </p>
          <div className="download-actions">
            <button className="btn btn-primary btn-download" onClick={handleDownloadUrl} disabled={loading}>
              {loading ? <><span className="spinner" /> Import…</> : "⬇️ Importer"}
            </button>
            <button className="btn btn-secondary btn-download" onClick={handleDownloadAndLoadUrl} disabled={loading}>
              {loading ? <><span className="spinner" /> Import…</> : "⚡ Importer et charger"}
            </button>
          </div>
        </div>

        <div className="card model-table-card">
          <div className="card-header-row">
            <div>
              <div className="card-title">🧠 Modèles</div>
              <div className="card-subtitle card-subtitle-inline">Un seul modèle est servi à la fois par llama.cpp. Le proxy l’expose aux autres conteneurs sous l’identifiant stable <strong>lia-local</strong>.</div>
            </div>
            <div className="auto-sync-label">Mise à jour auto</div>
          </div>
          {unifiedModelRows.length === 0 ? (
            <div className="empty-state">
              Aucun modèle GGUF local. Importe un fichier ci-dessus, puis charge-le pour démarrer llama-server.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="model-table">
                <thead>
                  <tr>
                    <th>Nom</th>
                    <th>État</th>
                    <th>Taille</th>
                    <th>VRAM</th>
                    <th>Modifié</th>
                    <th>Expire</th>
                    <th>Infos</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {unifiedModelRows.map((row) => (
                    <tr
                      key={row.name}
                      className={[
                        row.loaded ? "row-loaded" : "",
                        row.active ? "row-active" : "",
                        isPendingModel(row.name) ? "row-pending" : "",
                      ].filter(Boolean).join(" ")}
                    >
                      <td className="col-name">
                        <div className="table-model-name">{row.name}</div>
                      </td>
                      <td>
                        <div className="state-stack">
                          {row.active && <span className="badge badge-success">✓ Actif</span>}
                          {!row.active && row.loaded && <span className="badge badge-loaded">En mémoire</span>}
                          {!row.loaded && <span className="badge badge-neutral">Disponible</span>}
                          {isPendingModel(row.name, "load") && <span className="badge badge-pending"><span className="spinner spinner-small" /> Chargement…</span>}
                          {isPendingModel(row.name, "delete") && <span className="badge badge-pending"><span className="spinner spinner-small" /> Suppression…</span>}
                          {isPendingModel(row.name, "select") && <span className="badge badge-pending"><span className="spinner spinner-small" /> Activation…</span>}
                          {isPendingModel(row.name, "unload") && <span className="badge badge-pending"><span className="spinner spinner-small" /> Déchargement…</span>}
                        </div>
                      </td>
                      <td>{formatBytes(row.diskSize)}</td>
                      <td>{formatBytes(row.vramSize)}</td>
                      <td>{formatUnixDate(row.modifiedAt)}</td>
                      <td>{formatShortDate(row.expiresAt)}</td>
                      <td>
                        <button
                          className="btn btn-secondary btn-icon"
                          onClick={() => handleOpenModelDetails(row.name)}
                          disabled={loading || Boolean(pendingModelAction)}
                          title={`Afficher les détails GGUF de ${row.name}`}
                          aria-label={`Afficher les détails GGUF de ${row.name}`}
                        >
                          ℹ️
                        </button>
                      </td>
                      <td>
                        <div className="table-actions">
                          {row.loaded ? (
                            <>
                              <button
                                className="btn btn-primary btn-table"
                                onClick={() => handleSelectLoaded(row.name)}
                                disabled={loading || Boolean(pendingModelAction) || row.active}
                              >
                                {row.active ? "✓ Actif" : "Sélectionner"}
                              </button>
                              <button
                                className="btn btn-danger btn-table"
                                onClick={() => handleUnloadModel(row.name)}
                                disabled={loading || Boolean(pendingModelAction)}
                              >
                                Décharger
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="btn btn-primary btn-table"
                                onClick={() => handleLoadFile(row.name)}
                                disabled={loading || Boolean(pendingModelAction)}
                              >
                                Charger
                              </button>
                              <button
                                className="btn btn-danger btn-table"
                                onClick={() => handleDeleteFile(row.name)}
                                disabled={loading || Boolean(pendingModelAction)}
                              >
                                Supprimer
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Links */}
        <div className="card resource-card">
          <div className="card-title">🔗 Ressources</div>
          <div className="resource-links">
            <a href="https://github.com/ggml-org/llama.cpp" target="_blank" rel="noopener noreferrer" className="btn btn-outline">
              🧱 llama.cpp
            </a>
            <a href="https://huggingface.co/models?library=gguf" target="_blank" rel="noopener noreferrer" className="btn btn-outline">
              🤗 Hugging Face GGUF
            </a>
            <a href="https://ollama.com/library" target="_blank" rel="noopener noreferrer" className="btn btn-outline">
              📚 Ollama Library
            </a>
            <a href="http://localhost:3001" target="_blank" rel="noopener noreferrer" className="btn btn-outline">
              💬 AnythingLLM
            </a>
            <a href="http://localhost:3003" target="_blank" rel="noopener noreferrer" className="btn btn-outline">
              🌐 Open WebUI
            </a>
          </div>
          <p className="hint">
            Le proxy OpenAI-compatible de ce conteneur est publié sur <code>/v1</code> et présenté aux autres services sous l’identifiant <code>lia-local</code>.
          </p>
        </div>

        {detailsOpen && (
          <div className="modal-backdrop" onClick={handleCloseModelDetails}>
            <div className="modal-card" onClick={(event) => event.stopPropagation()}>
              <div className="modal-header-row">
                <div>
                  <div className="card-title">🔬 Détails du modèle</div>
                  <div className="card-subtitle card-subtitle-inline">
                    {selectedModelDetails?.model?.filename || "Lecture des métadonnées GGUF..."}
                  </div>
                </div>
                <button className="btn btn-secondary btn-close-modal" onClick={handleCloseModelDetails}>
                  Fermer
                </button>
              </div>

              {detailsLoading ? (
                <div className="empty-state modal-empty-state"><span className="spinner" /> Lecture du fichier GGUF...</div>
              ) : detailsError ? (
                <div className="notification error">{detailsError}</div>
              ) : selectedModelDetails ? (
                <div className="modal-content-grid">
                  <div className="status-grid status-grid-detail">
                    <div className="status-item status-item-glow">
                      <label>Architecture</label>
                      <div className="value">{selectedModelDetails.gguf?.architecture || "—"}</div>
                    </div>
                    <div className="status-item">
                      <label>Contexte détecté</label>
                      <div className="value">{formatCount(selectedModelDetails.gguf?.context_length)}</div>
                    </div>
                    <div className="status-item">
                      <label>Version GGUF</label>
                      <div className="value">{formatCount(selectedModelDetails.gguf?.version)}</div>
                    </div>
                    <div className="status-item">
                      <label>KV count</label>
                      <div className="value">{formatCount(selectedModelDetails.gguf?.kv_count)}</div>
                    </div>
                    <div className="status-item">
                      <label>Tensor count</label>
                      <div className="value">{formatCount(selectedModelDetails.gguf?.tensor_count)}</div>
                    </div>
                    <div className="status-item">
                      <label>Taille fichier</label>
                      <div className="value">{formatBytes(selectedModelDetails.model?.size)}</div>
                    </div>
                  </div>

                  <div className="modal-section">
                    <div className="card-title">🧾 Métadonnées GGUF</div>
                    <div className="table-wrap modal-table-wrap">
                      <table className="model-table metadata-table">
                        <thead>
                          <tr>
                            <th>Clé</th>
                            <th>Type</th>
                            <th>Valeur</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(selectedModelDetails.gguf?.metadata || []).map((entry) => (
                            <tr key={entry.key}>
                              <td className="metadata-key">{entry.key}</td>
                              <td className="metadata-type">{entry.type}</td>
                              <td className="metadata-value-cell">
                                <pre className="metadata-value">{entry.value_display}</pre>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="modal-section">
                    <div className="card-title">🧱 Tenseurs</div>
                    <div className="tensor-groups">
                      {tensorGroups.map((group) => (
                        <section key={group.name} className="tensor-group-card">
                          <div className="tensor-group-title">{group.name} <span>{group.tensors.length}</span></div>
                          <div className="table-wrap modal-table-wrap">
                            <table className="model-table tensor-table">
                              <thead>
                                <tr>
                                  <th>Nom</th>
                                  <th>Shape</th>
                                  <th>Type</th>
                                  <th>Offset</th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.tensors.map((tensor) => (
                                  <tr key={tensor.name}>
                                    <td className="metadata-key">{tensor.name}</td>
                                    <td>{formatTensorShape(tensor.dimensions)}</td>
                                    <td>{tensor.type}</td>
                                    <td>{formatCount(tensor.offset)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </section>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
