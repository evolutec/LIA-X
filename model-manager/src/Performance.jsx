import { useEffect, useMemo, useState } from "react";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

function formatBytes(value) {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (Number.isNaN(number)) return String(value);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = number;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
}

function formatPercent(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "—";
  }
  return `${Number(value).toFixed(1)} %`;
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) {
    return "—";
  }
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs}h ${mins}m ${secs}s`;
}

function Performance() {
  const [performance, setPerformance] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchPerformance = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${apiBase}/api/performance`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.detail || response.statusText || "Erreur API");
      }
      setPerformance(payload);
      setError("");
    } catch (err) {
      setError(err?.message || "Impossible de récupérer les métriques");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPerformance();
    const interval = window.setInterval(fetchPerformance, 5000);
    return () => window.clearInterval(interval);
  }, []);

  const cpuCards = useMemo(() => (performance?.hardware || []).filter((item) => item.type === "cpu"), [performance]);
  const gpuCards = useMemo(() => (performance?.hardware || []).filter((item) => item.type === "gpu"), [performance]);

  return (
    <div className="card performance-card">
      <div className="card-title">💻 Performance</div>
      <p className="card-subtitle">Spécifications et utilisation du matériel détecté.</p>

      {error && <div className="notification error">{error}</div>}

      <div className="performance-summary">
        <div className="summary-stack">
          <div className="summary-title">Plateforme</div>
          <div>{performance?.system?.platform || "—"}</div>
        </div>
        <div className="summary-stack">
          <div className="summary-title">Architecture</div>
          <div>{performance?.system?.arch || "—"}</div>
        </div>
        <div className="summary-stack">
          <div className="summary-title">Uptime</div>
          <div>{formatDuration(performance?.system?.uptime_seconds)}</div>
        </div>
        <div className="summary-stack">
          <div className="summary-title">RAM système</div>
          <div>{performance?.memory ? `${formatBytes(performance.memory.used_bytes)} / ${formatBytes(performance.memory.total_bytes)}` : '—'}</div>
        </div>
      </div>

      <div className="performance-grid">
        {cpuCards.map((cpu) => (
          <div key={cpu.id} className="hardware-card">
            <div className="hardware-card-title">CPU {cpu.id.replace('cpu-', 'Core ')}</div>
            <div className="hardware-card-meta">{cpu.model}</div>
            <div className="hardware-detail">Vitesse : {cpu.speed_mhz || '—'} MHz</div>
            <div className="hardware-detail">Usage : {formatPercent(cpu.usage_percent)}</div>
            <div className="usage-bar">
              <div className="usage-fill" style={{ width: `${cpu.usage_percent || 0}%` }} />
            </div>
          </div>
        ))}
        {gpuCards.map((gpu) => (
          <div key={gpu.id} className="hardware-card">
            <div className="hardware-card-title">GPU {gpu.id}</div>
            <div className="hardware-card-meta">{gpu.vendor} {gpu.model}</div>
            <div className="hardware-detail">VRAM utilisée : {formatBytes(gpu.memory_used_bytes)} / {formatBytes(gpu.memory_total_bytes)}</div>
            <div className="hardware-detail">Utilisation GPU : {formatPercent(gpu.usage_percent)}</div>
            <div className="usage-bar">
              <div className="usage-fill" style={{ width: `${gpu.usage_percent || 0}%` }} />
            </div>
          </div>
        ))}
      </div>

      {loading && <div className="placeholder-block">Mise à jour des métriques…</div>}
      {!loading && cpuCards.length === 0 && gpuCards.length === 0 && (
        <div className="placeholder-block">Aucun matériel détecté ou métriques indisponibles.</div>
      )}
    </div>
  );
}

export default Performance;
