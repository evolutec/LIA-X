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
      setStatus(`Modèle chargé : ${data.model}`);
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
      setStatus(`Modèle actif : ${data.active_model}`);
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

  async function handleDropCache() {
    setStatus("Vidage du cache mémoire Linux en cours...");
    try {
      const res = await fetch(`${apiBase}/api/cache/drop`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setStatus("Cache mémoire vidé. La RAM libre a été restituée.");
    } catch (err) {
      setStatus(`Échec vider cache : ${err.message}`);
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>⚡ Model Manager — Ollama IPEX</h1>
        <div className="backend-badge">
          <span className={`dot ${version ? "" : "offline"}`}></span>
          <span>{version ? `Connecté · Ollama ${version.version ?? ""}` : "Ollama hors ligne"}</span>
        </div>
      </header>

      <div className="app-content">
        {status && (
          <div className={`notification ${status.includes("Échec") || status.includes("unavailable") || status.includes("offline") ? "error" : "info"}`}>
            {status}
          </div>
        )}

        {/* Backend status */}
        <div className="card">
          <div className="card-title">📊 Statut</div>
          <div className="card-subtitle">{formatSyncTime(lastSyncedAt)}</div>
          <div className="status-row">
            <div className="status-item">
              <label>Version Ollama</label>
              <div className="value">{version?.version ?? "—"}</div>
            </div>
            <div className="status-item">
              <label>Device</label>
              <div className="value">{version?.device ?? "—"}</div>
            </div>
            <div className="status-item">
              <label>Modèle actif</label>
              <div className="value">{activeModel || "—"}</div>
            </div>
            <div className="status-item">
              <label>Stockage</label>
              <div className="value">{version?.model_dir ?? "—"}</div>
            </div>
          </div>
        </div>

        {/* Download */}
        <div className="card">
          <div className="card-title">⬇️ Télécharger un modèle</div>
          {downloadProgress > 0 && (
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${downloadProgress}%` }}></div>
              <span className="progress-text">{downloadProgress}%</span>
            </div>
          )}
          <div className="form-grid">
            <input
              type="text"
              value={ollamaName}
              onChange={(e) => setOllamaName(e.target.value)}
              placeholder="qwen2.5:0.5b, llama3.2:1b… (nom Ollama)"
              aria-label="Nom du modèle Ollama"
            />
            <button className="btn btn-secondary" onClick={handleDownloadUrl} disabled={loading}>
              {loading ? <><span className="spinner" /> En cours…</> : "⬇️ Télécharger"}
            </button>
            <button className="btn btn-primary" onClick={handleDownloadAndLoadUrl} disabled={loading}>
              {loading ? <><span className="spinner" /> En cours…</> : "⚡ Télécharger & Charger"}
            </button>
          </div>
          <p className="hint">
            Nom de modèle Ollama (ex&nbsp;: <code>qwen2.5:0.5b</code>, <code>llama3.2:1b</code>, <code>phi3.5:mini</code>).
            Les modèles sont stockés dans <strong>~/.ollama/models</strong> (WSL2 Ubuntu).
          </p>

          <div className="hf-divider"><span>— ou importer un fichier GGUF direct depuis HuggingFace —</span></div>

          <div className="form-grid">
            <input
              type="text"
              value={huggingfaceUrl}
              onChange={(e) => handleHFUrlChange(e.target.value)}
              placeholder="https://huggingface.co/…/resolve/main/model.Q4_K_M.gguf"
              aria-label="URL GGUF HuggingFace"
              style={{ gridColumn: "1 / -1" }}
            />
            <input
              type="text"
              value={hfModelName}
              onChange={(e) => setHfModelName(e.target.value)}
              placeholder="Nom local du modèle (auto-détecté)"
              aria-label="Nom local du modèle"
            />
            <button className="btn btn-secondary" onClick={() => handleImportHF(false)} disabled={loading}>
              {loading ? <><span className="spinner" /> En cours…</> : "⬇️ Importer"}
            </button>
            <button className="btn btn-primary" onClick={() => handleImportHF(true)} disabled={loading}>
              {loading ? <><span className="spinner" /> En cours…</> : "⚡ Importer & Charger"}
            </button>
          </div>
          <p className="hint">
            Colle l'URL d'un fichier <code>.gguf</code> HuggingFace (ex&nbsp;: <code>…/resolve/main/Qwen3.5-9B.Q4_K_M.gguf</code>).
            Le nom du modèle est auto-détecté depuis l'URL — tu peux le modifier avant d'importer. Les boutons de téléchargement détectent aussi automatiquement une URL GGUF HuggingFace collée dans ce champ.
          </p>
        </div>

        {/* Available models */}
        <div className="card">
          <div className="card-header-row">
            <div className="card-title">📂 Modèles disponibles</div>
            <div className="auto-sync-label">Mise à jour auto</div>
          </div>
          {availableFiles.length === 0 ? (
            <div className="empty-state">
              Aucun modèle. Téléchargez-en un ci-dessus ou via&nbsp;:
              <br/><code>wsl -d Ubuntu-24.04 -- bash -c 'cd ~/ollama-ipex && ./ollama pull qwen2.5:0.5b'</code>
            </div>
          ) : (
            <div className="model-grid">
              {availableFiles.map((file) => (
                <div
                  key={getAvailableModelName(file)}
                  className={`model-card ${getAvailableModelName(file) === activeModel ? "active-model" : ""} ${isPendingModel(getAvailableModelName(file)) ? "pending-model" : ""}`}
                >
                  <div className="model-name">{getAvailableModelName(file)}</div>
                  {getAvailableModelName(file) === activeModel && (
                    <span className="badge badge-success">✓ Actif</span>
                  )}
                  {isPendingModel(getAvailableModelName(file), "load") && (
                    <span className="badge badge-pending"><span className="spinner spinner-small" /> Chargement…</span>
                  )}
                  {isPendingModel(getAvailableModelName(file), "delete") && (
                    <span className="badge badge-pending"><span className="spinner spinner-small" /> Suppression…</span>
                  )}
                  <div className="model-meta">
                    <span>Taille : {formatBytes(file.size)}</span>
                    <span>Modifié le {new Date(Number(file.modified_at) * 1000).toLocaleDateString("fr-FR")}</span>
                  </div>
                  <div className="model-actions">
                    <button
                      className="btn btn-primary"
                      onClick={() => handleLoadFile(file.name)}
                      disabled={loading || Boolean(pendingModelAction)}
                    >
                      {isPendingModel(getAvailableModelName(file), "load") ? <><span className="spinner" /> Chargement…</> : "⚡ Charger"}
                    </button>
                    <button className="btn btn-danger" onClick={() => handleDeleteFile(file.name)} disabled={loading || Boolean(pendingModelAction)}>
                      {isPendingModel(getAvailableModelName(file), "delete") ? <><span className="spinner" /> Suppression…</> : "🗑 Supprimer"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Loaded models (running in memory) */}
        <div className="card">
          <div className="card-header-row">
            <div className="card-title">🧠 Modèles en mémoire (VRAM)</div>
            <div className="auto-sync-label">Mise à jour auto</div>
          </div>
          {loadedModels.length === 0 ? (
            <div className="empty-state">Aucun modèle chargé en VRAM. Chargez-en un depuis la liste ci-dessus.</div>
          ) : (
            <div className="model-grid">
              {loadedModels.map((item) => (
                <div
                  key={getLoadedModelName(item)}
                  className={`model-card ${getLoadedModelName(item) === activeModel ? "active-model" : ""} ${isPendingModel(getLoadedModelName(item)) ? "pending-model" : ""}`}
                >
                  <div className="model-name">{getLoadedModelName(item)}</div>
                  {getLoadedModelName(item) === activeModel && (
                    <span className="badge badge-success">✓ Actif</span>
                  )}
                  {isPendingModel(getLoadedModelName(item), "select") && (
                    <span className="badge badge-pending"><span className="spinner spinner-small" /> Activation…</span>
                  )}
                  {isPendingModel(getLoadedModelName(item), "unload") && (
                    <span className="badge badge-pending"><span className="spinner spinner-small" /> Déchargement…</span>
                  )}
                  <div className="model-meta">
                    <span>VRAM : {formatBytes(item.size_vram)}</span>
                    <span>Expire : {item.expires_at ? new Date(item.expires_at).toLocaleTimeString("fr-FR") : "—"}</span>
                  </div>
                  <div className="model-actions">
                    <button
                      className="btn btn-primary"
                      onClick={() => handleSelectLoaded(item.model)}
                      disabled={loading || Boolean(pendingModelAction) || item.model === activeModel}
                    >
                      {isPendingModel(getLoadedModelName(item), "select") ? <><span className="spinner" /> Activation…</> : item.model === activeModel ? "✓ Sélectionné" : "Sélectionner"}
                    </button>
                    <button
                      className="btn btn-danger"
                      onClick={() => handleUnloadModel(item.model)}
                      disabled={loading || Boolean(pendingModelAction)}
                    >
                      {isPendingModel(getLoadedModelName(item), "unload") ? <><span className="spinner" /> Déchargement…</> : "Décharger"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Detailed status */}
        <div className="card">
          <div className="card-header-row">
            <div className="card-title">📈 Statut détaillé</div>
            <div className="card-header-actions">
              <button className="btn btn-warning" onClick={handleDropCache} disabled={loading} title="Vide le page cache Linux pour libérer de la RAM (sans aucun modèle chargé)">
                🧹 Vider Cache
              </button>
              <button className="btn btn-secondary" onClick={refreshStatusInfo} disabled={loading}>
                ↻ Rafraîchir
              </button>
            </div>
          </div>
          {statusInfo ? (
            <>
              <div className="status-grid">
                <div className="status-item">
                  <label>Total modèles</label>
                  <div className="value">{statusInfo.total_models}</div>
                </div>
                <div className="status-item">
                  <label>GPU</label>
                  <div className="value">{statusInfo.gpu?.device ?? "N/A"}</div>
                </div>
                <div className="status-item">
                  <label>En mémoire</label>
                  <div className="value">{statusInfo.running_models ?? 0}</div>
                </div>
              </div>
              {statusInfo.models?.length > 0 && (
                <div className="model-grid">
                  {statusInfo.models.map((item) => (
                    <div key={String(item.model)} className="model-card">
                      <div className="model-name">{String(item.model)}</div>
                      <div className="model-meta">
                        <span>Device : {String(item.device ?? "—")}</span>
                        <span>VRAM : {formatBytes(item.approx_memory_bytes)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">Statut non disponible. Cliquez sur ↻ Rafraîchir.</div>
          )}
        </div>

        {/* Links */}
        <div className="card">
          <div className="card-title">🔗 Ressources</div>
          <div className="resource-links">
            <a href="https://ollama.com/library" target="_blank" rel="noopener noreferrer" className="btn btn-outline">
              🦙 Ollama Library
            </a>
            <a href="https://huggingface.co/models?library=gguf" target="_blank" rel="noopener noreferrer" className="btn btn-outline">
              🤗 Hugging Face GGUF
            </a>
            <a href="http://localhost:3001" target="_blank" rel="noopener noreferrer" className="btn btn-outline">
              💬 AnythingLLM
            </a>
          </div>
          <p className="hint">
            Modèles recommandés pour Arc 140V&nbsp;: <code>qwen2.5:0.5b</code>, <code>qwen2.5:1.5b</code>, <code>llama3.2:1b</code>, <code>phi3.5:mini</code>
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;
