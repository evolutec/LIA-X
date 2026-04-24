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

function normalizeGpuVendor(vendor, label) {
  const value = String(vendor || label || '').toLowerCase();
  if (/nvidia|geforce|quadro|rtx|gtx/.test(value)) return 'NVIDIA';
  if (/amd|radeon|instinct|firepro/.test(value)) return 'AMD';
  if (/intel|arc|uhd|iris/.test(value)) return 'Intel';
  return 'GPU';
}

function Performance() {
  const [performance, setPerformance] = useState(null);
  const [memoryHistory, setMemoryHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const appendMemoryPoint = (payload) => {
    if (!payload?.memory) {
      return;
    }

    const hostTotal = payload.memory.host_total_bytes ?? payload.memory.total_bytes ?? null;
    const hostFree = payload.memory.host_free_bytes ?? payload.memory.free_bytes ?? null;
    const hostUsed = payload.memory.host_used_bytes ?? payload.memory.used_bytes ?? (hostTotal != null && hostFree != null ? hostTotal - hostFree : null);
    if (hostTotal == null || hostUsed == null) {
      return;
    }

    setMemoryHistory((previous) => {
      const next = [...previous, { timestamp: Date.now(), used: hostUsed, total: hostTotal }];
      return next.slice(-34);
    });
  };

  const fetchPerformance = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${apiBase}/api/performance`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.detail || response.statusText || "Erreur API");
      }
      setPerformance(payload);
      appendMemoryPoint(payload);
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

  const cpuItems = useMemo(() => (performance?.hardware || []).filter((item) => item.type === "cpu"), [performance]);
  const cpuProfile = performance?.profile?.cpu || null;

  const cpuSummary = useMemo(() => {
    if (cpuItems.length > 0) {
      const averageUsage = cpuItems.reduce((sum, cpu) => sum + (Number(cpu.usage_percent) || 0), 0) / cpuItems.length;
      return {
        model: cpuItems[0].model || cpuProfile?.model || '—',
        usage_percent: averageUsage,
        logical_processors: cpuProfile?.logical_processors || cpuItems.length,
        physical_cores: cpuProfile?.physical_cores || cpuItems.length,
        current_clock_speed_mhz: cpuItems[0].speed_mhz || cpuProfile?.current_clock_speed_mhz,
        max_clock_speed_mhz: cpuProfile?.max_clock_speed_mhz || cpuItems[0].speed_mhz,
        cores: cpuItems.map((cpu, index) => ({
          id: cpu.id || `core-${index + 1}`,
          label: `Core ${index + 1}`,
          usage_percent: Number(cpu.usage_percent) || 0,
        })),
      };
    }
    if (cpuProfile) {
      return {
        model: cpuProfile.model || '—',
        usage_percent: cpuProfile.usage_percent ?? null,
        logical_processors: cpuProfile.logical_processors || null,
        physical_cores: cpuProfile.physical_cores || null,
        current_clock_speed_mhz: cpuProfile.current_clock_speed_mhz || cpuProfile.max_clock_speed_mhz || null,
        max_clock_speed_mhz: cpuProfile.max_clock_speed_mhz || null,
        cores: [],
      };
    }
    return null;
  }, [cpuItems, cpuProfile]);

  const gpuItems = useMemo(() => (performance?.hardware || []).filter((item) => item.type === "gpu"), [performance]);
  const gpuProfile = performance?.profile?.gpu || null;

  const parseGpuMemoryFromLabel = (label) => {
    if (!label || typeof label !== 'string') return null;
    const match = label.match(/(\d+(?:[\.,]\d+)?)\s*(GB|Go|MB|Mo)/i);
    if (!match) return null;
    const value = Number(match[1].replace(',', '.'));
    if (!Number.isFinite(value)) return null;
    const unit = match[2].toLowerCase();
    if (unit.startsWith('g')) return Math.round(value * 1024 * 1024 * 1024);
    if (unit.startsWith('m')) return Math.round(value * 1024 * 1024);
    return null;
  };

  const gpuSummary = useMemo(() => {
    if (gpuItems.length > 0) {
      return gpuItems[0];
    }
    if (gpuProfile) {
      const device = gpuProfile.devices?.[0] || {};
      const totalBytes = Number.isFinite(Number(device.adapter_ram_bytes))
        ? Number(device.adapter_ram_bytes)
        : parseGpuMemoryFromLabel(gpuProfile.label || gpuProfile.model || '');
      return {
        id: 'gpu-profile',
        type: 'gpu',
        vendor: gpuProfile.vendor || device.name || gpuProfile.label || 'GPU',
        model: gpuProfile.label || device.name || 'GPU',
        usage_percent: null,
        memory_total_bytes: totalBytes,
        memory_used_bytes: null,
        driver: device.driver_version || null,
      };
    }
    return null;
  }, [gpuItems, gpuProfile]);

  const memoryInfo = useMemo(() => {
    const hostTotal = performance?.memory?.host_total_bytes ?? performance?.memory?.total_bytes ?? null;
    const hostFree = performance?.memory?.host_free_bytes ?? performance?.memory?.free_bytes ?? null;
    const hostUsed = performance?.memory?.host_used_bytes ?? performance?.memory?.used_bytes ?? (hostTotal != null && hostFree != null ? hostTotal - hostFree : null);
    const memoryUsage = hostTotal != null && hostUsed != null ? (hostUsed / hostTotal) * 100 : null;
    return {
      total_bytes: hostTotal,
      used_bytes: hostUsed,
      free_bytes: hostFree,
      usage_percent: Number.isFinite(memoryUsage) ? memoryUsage : null,
    };
  }, [performance]);

  const memoryChartPoints = useMemo(() => {
    if (!memoryHistory.length) {
      return null;
    }

    const maxTotal = Math.max(...memoryHistory.map((point) => point.total || 0));
    if (maxTotal === 0) {
      return null;
    }

    const usedPoints = [];
    const freePoints = [];

    memoryHistory.forEach((point, index) => {
      const x = memoryHistory.length > 1 ? (index / (memoryHistory.length - 1)) * 100 : 0;
      const usedY = point.used != null ? 100 - Math.min(Math.max((point.used / maxTotal) * 100, 0), 100) : 100;
      const freeY = point.used != null ? 100 - Math.min(Math.max(((point.total - point.used) / maxTotal) * 100, 0), 100) : 100;
      usedPoints.push(`${x},${usedY}`);
      freePoints.push(`${x},${freeY}`);
    });

    return {
      used: usedPoints.join(' '),
      free: freePoints.join(' '),
    };
  }, [memoryHistory]);

  const platform = performance?.system?.platform || '—';
  const arch = performance?.system?.arch || '—';
  const uptime = formatDuration(performance?.system?.uptime_seconds);
  const memoryHostTotal = memoryInfo.total_bytes;
  const memoryHostUsed = memoryInfo.used_bytes;
  const memoryUsagePercent = memoryInfo.usage_percent;
  const gpuVendorLabel = gpuSummary ? normalizeGpuVendor(gpuSummary.vendor, gpuSummary.model) : null;

  return (
    <div className="card performance-card">
      <div className="card-title">💻 Performance</div>
      <p className="card-subtitle">Vue unifiée du CPU, GPU et de la santé du système.</p>

      {error && <div className="notification error">{error}</div>}

      <div className="performance-hero">
        <div className="performance-hero-card cpu-card">
          <div className="performance-hero-head">
            <div>
              <div className="performance-hero-label">CPU</div>
              <div className="performance-hero-name">{cpuSummary?.model || 'Aucun CPU détecté'}</div>
            </div>
            <div className="performance-chip">{cpuSummary?.physical_cores ?? '—'} cœurs</div>
          </div>
          <div className="gauge-ring" style={{ '--gauge-percent': `${Math.min(Math.max(cpuSummary?.usage_percent ?? 0, 0), 100)}%` }}>
            <div className="gauge-ring-fill" />
            <div className="gauge-ring-inner">
              <span>{formatPercent(cpuSummary?.usage_percent)}</span>
              <small>Utilisation</small>
            </div>
          </div>
          <div className="performance-meta-row">
            <div className="performance-metric">
              <span>Fréquence</span>
              <strong>{cpuSummary?.current_clock_speed_mhz ? `${cpuSummary.current_clock_speed_mhz} MHz` : '—'}</strong>
            </div>
            <div className="performance-metric">
              <span>Threads</span>
              <strong>{cpuSummary?.logical_processors ?? '—'}</strong>
            </div>
          </div>
          <div className="performance-metric">
            <span>RAM système</span>
            <strong>{formatBytes(memoryHostUsed)} / {formatBytes(memoryHostTotal)}</strong>
          </div>
          {cpuSummary?.cores?.length > 0 && (
            <div className="core-usage-list">
              {cpuSummary.cores.map((core) => (
                <div key={core.id} className="core-usage-item">
                  <span>{core.label}</span>
                  <div className="core-usage-track">
                    <div className="core-usage-bar" style={{ width: `${Math.min(Math.max(core.usage_percent, 0), 100)}%` }} />
                  </div>
                  <span>{formatPercent(core.usage_percent)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="performance-hero-card gpu-card">
          <div className="performance-hero-head">
            <div>
              <div className="performance-hero-label">{gpuVendorLabel || 'GPU'}</div>
              <div className="performance-hero-name">{gpuSummary?.model || 'Aucun GPU détecté'}</div>
            </div>
            {gpuVendorLabel && <div className={`performance-chip vendor-${gpuVendorLabel.toLowerCase()}`}>{gpuVendorLabel}</div>}
          </div>
          <div className="gpu-info-grid">
            <div>
              <span>VRAM</span>
              <strong>{formatBytes(gpuSummary?.memory_total_bytes)}</strong>
            </div>
            <div>
              <span>Driver</span>
              <strong>{gpuSummary?.driver || '—'}</strong>
            </div>
          </div>
          <div className="gpu-usage-bar">
            <div className="gpu-usage-track">
              <div className="gpu-usage-fill" style={{ width: `${Math.min(Math.max(gpuSummary?.usage_percent ?? 0, 0), 100)}%` }} />
            </div>
            <span>{gpuSummary?.usage_percent != null ? formatPercent(gpuSummary.usage_percent) : 'Pas de métrique'} </span>
          </div>
          <div className="gpu-chipset-note">{gpuSummary ? `Détecté comme ${gpuVendorLabel}` : 'Aucun GPU supporté détecté'}</div>
        </div>
      </div>

      <div className="performance-grid">
        <div className="hardware-card">
          <div className="hardware-card-title">Système</div>
          <div className="hardware-card-meta">{platform} · {arch}</div>
          <div className="hardware-detail">Uptime : {uptime}</div>
          <div className="hardware-detail">CPU : {cpuSummary?.model || '—'}</div>
          <div className="hardware-detail">GPU : {gpuSummary?.model || 'Aucun'}</div>
        </div>
        <div className="memory-card">
          <div className="hardware-card-title">Mémoire</div>
          <div className="hardware-card-meta">Hôte physique</div>
          <div className="hardware-detail">Total : {formatBytes(memoryHostTotal)}</div>
          <div className="hardware-detail">Utilisé : {formatBytes(memoryHostUsed)}</div>
          <div className="hardware-detail">Libre : {formatBytes(memoryInfo.free_bytes)}</div>
          <div className="hardware-detail">Charge : {memoryUsagePercent != null ? formatPercent(memoryUsagePercent) : '—'}</div>
          <div className="memory-chart">
            <div className="memory-chart-visual">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="memory-chart-svg" aria-label="Graphique d’usage mémoire">
                <defs>
                  <linearGradient id="memoryChartGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgba(34, 197, 94, 0.5)" />
                    <stop offset="100%" stopColor="rgba(34, 197, 94, 0.05)" />
                  </linearGradient>
                </defs>
                <rect x="0" y="0" width="100" height="100" fill="none" />
                {memoryChartPoints && (
                  <polyline
                    points={memoryChartPoints.used}
                    fill="none"
                    stroke="#5eead4"
                    strokeWidth="2"
                    className="memory-chart-line memory-chart-line-used"
                  />
                )}
                {memoryChartPoints && (
                  <polyline
                    points={memoryChartPoints.free}
                    fill="none"
                    stroke="#60a5fa"
                    strokeWidth="2"
                    strokeDasharray="4 4"
                    className="memory-chart-line memory-chart-line-free"
                  />
                )}
                {memoryChartPoints && (
                  <polygon
                    points={`${memoryChartPoints.used} 100,100 0,100`}
                    fill="url(#memoryChartGradient)"
                    className="memory-chart-fill"
                  />
                )}
              </svg>
              <div className="memory-chart-rules">
                {[...Array(4)].map((_, idx) => (
                  <div key={idx} />
                ))}
              </div>
            </div>
            <div className="memory-chart-footer">
              <div className="memory-chart-legend">
                <span className="memory-chart-legend-item used">Utilisé</span>
                <span className="memory-chart-legend-item free">Libre</span>
              </div>
              <span>{memoryHistory.length} points</span>
            </div>
          </div>
        </div>
        <div className="hardware-card">
          <div className="hardware-card-title">Profil matériel</div>
          <div className="hardware-card-meta">{performance?.profile?.gpu?.label || performance?.profile?.cpu?.model || '—'}</div>
          <div className="hardware-detail">CPU : {cpuSummary?.model || '—'}</div>
          <div className="hardware-detail">GPU : {gpuSummary?.model || 'Aucun'}</div>
        </div>
      </div>

      {loading && <div className="placeholder-block">Mise à jour des métriques…</div>}
      {!loading && !cpuSummary && !gpuSummary && (
        <div className="placeholder-block">Aucun matériel détecté ou métriques indisponibles.</div>
      )}
    </div>
  );
}

export default Performance;
