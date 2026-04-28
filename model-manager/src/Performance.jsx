import { useEffect, useMemo, useRef, useState } from "react";

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

    const hostTotal = payload.memory.TotalBytes ?? payload.memory.host_total_bytes ?? payload.memory.total_bytes ?? null;
    const hostFree = payload.memory.FreeBytes ?? payload.memory.host_free_bytes ?? payload.memory.free_bytes ?? null;
    const hostUsed = payload.memory.UsedBytes ?? payload.memory.host_used_bytes ?? payload.memory.used_bytes ?? (hostTotal != null && hostFree != null ? hostTotal - hostFree : null);
    if (hostTotal == null || hostUsed == null) {
      return;
    }

    setMemoryHistory((previous) => {
      const next = [...previous, { timestamp: Date.now(), used: hostUsed, total: hostTotal }];
      return next.slice(-25);
    });
  };

  const isFetchingRef = useRef(false);

const fetchPerformance = async (isInitial = false) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    if (isInitial) setLoading(true);
    try {
      const response = await fetch(`http://127.0.0.1:13620/metrics/host`);
      
      let payload;
      try {
        payload = await response.json();
      } catch (e) {
        throw new Error("Réponse API invalide");
      }
      
      if (!response.ok) {
        throw new Error(response.statusText || "Erreur API");
      }
      
      // Adapter le format de l'API
      const adapted = {
        hardware: [],
        profile: {
          cpu: payload.system?.CPU,
          gpu: { vendor: payload.gpuType, label: payload.metrics?.GPU?.Name }
        },
        memory: payload.metrics?.Memory,
        system: {
          platform: payload.system?.OS?.Caption,
          arch: payload.system?.CPU?.Name,
          uptime_seconds: payload.system?.OS?.Uptime
        }
      };

      // Ajouter CPU
      if (payload.metrics?.CPU?.Cores) {
        payload.metrics.CPU.Cores.forEach((core, idx) => {
           adapted.hardware.push({
             type: 'cpu',
             id: core.CoreId,
             model: payload.system?.CPU?.Name,
              usage_percent: core.LoadPercent,
             speed_mhz: core.FrequencyMHz
           });
        });
      }

      // Ajouter GPU(s) - CORRECTION: GPUs est un OBJECT dans l'API pas un ARRAY, on transforme en tableau
      let gpuList = [];
      if (payload.metrics?.GPUs) {
        if (Array.isArray(payload.metrics.GPUs)) {
          gpuList = payload.metrics.GPUs;
        } else {
          // Cas ou l'API retourne directement un objet unique au lieu d'un tableau
          gpuList = [ payload.metrics.GPUs ];
        }
      }

      if (gpuList.length > 0) {
        gpuList.forEach((gpu, idx) => {
          adapted.hardware.push({
            type: 'gpu',
            id: `gpu-${idx}`,
            vendor: normalizeGpuVendor(gpu.Vendor, gpu.Name),
            model: gpu.Name,
            usage_percent: gpu.LoadPercent,
           memory_total_bytes: gpu.AdapterRAMBytes,
           memory_used_bytes: gpu.VramUsedBytes,
            temperature_celsius: gpu.TemperatureCelsius,
            power_draw_watts: gpu.PowerDrawWatts,
            driver: gpu.DriverVersion,
            source: gpu.Source
          });
        });
      } else if (payload.metrics?.GPU) {
        adapted.hardware.push({
          type: 'gpu',
          id: 'gpu-0',
          vendor: payload.gpuType,
          model: payload.metrics.GPU.Name,
            usage_percent: payload.metrics.GPU.LoadPercent,
           memory_total_bytes: payload.metrics.GPU.AdapterRAMBytes,
           memory_used_bytes: payload.metrics.GPU.VramUsedBytes,
          driver: payload.metrics.GPU.DriverVersion,
          source: payload.metrics.GPU.Source
        });
      }

      setPerformance(adapted);
      
      // Ajouter le point mémoire à chaque mise à jour
      appendMemoryPoint(payload.metrics);
      setError("");
    } catch (err) {
      setError(err?.message || "Impossible de récupérer les métriques");
    } finally {
      if (isInitial) setLoading(false);
      isFetchingRef.current = false;
    }
  };

  useEffect(() => {
    fetchPerformance(true);
    const interval = window.setInterval(() => fetchPerformance(false), 500);
    return () => window.clearInterval(interval);
  }, []);

  const cpuItems = useMemo(() => (performance?.hardware || []).filter((item) => item.type === "cpu"), [performance]);
  const cpuProfile = performance?.profile?.cpu || null;

  // Fallback vers les capacités natives du navigateur
  const deviceMemory = navigator.deviceMemory ? Number(navigator.deviceMemory) : null;
  const webgpu = typeof navigator.gpu !== 'undefined' ? navigator.gpu : null;

  // Moyenne glissante sur 8 échantillons
  const [cpuAvgHistory, setCpuAvgHistory] = useState([]);
  const [memAvgHistory, setMemAvgHistory] = useState([]);

  useEffect(() => {
    if (performance && performance.hardware) {
      const averageUsage = cpuItems.reduce((sum, cpu) => sum + (Number(cpu.usage_percent) || 0), 0) / cpuItems.length;
      setCpuAvgHistory(prev => [...prev, averageUsage].slice(-8));

      const memPct = performance?.memory?.UsedPercent ?? 0;
      setMemAvgHistory(prev => [...prev, memPct].slice(-8));
    }
  }, [performance]);

  const cpuSummary = useMemo(() => {
    if (cpuItems.length > 0) {
      const averageUsage = cpuAvgHistory.length > 0 
        ? cpuAvgHistory.reduce((sum, v) => sum + v, 0) / cpuAvgHistory.length
        : cpuItems.reduce((sum, cpu) => sum + (Number(cpu.usage_percent) || 0), 0) / cpuItems.length;
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
    
    // Fallback vers les données natives si l'API ne fournit pas CPU
    if (deviceMemory != null) {
      return {
        model: 'Navigateur',
        usage_percent: null,
        logical_processors: null,
        physical_cores: null,
        current_clock_speed_mhz: null,
        max_clock_speed_mhz: null,
        cores: [],
      };
    }
    
    return null;
  }, [cpuItems, cpuProfile, deviceMemory]);

  const gpuItems = useMemo(() => {
    const items = (performance?.hardware || []).filter((item) => item.type === "gpu");
    // Prioriser les GPUs avec des métriques réelles (usage non-null, plus de VRAM)
    return items.sort((a, b) => {
      const aHasData = a.usage_percent != null || a.memory_total_bytes > 0;
      const bHasData = b.usage_percent != null || b.memory_total_bytes > 0;
      if (aHasData && !bHasData) return -1;
      if (!aHasData && bHasData) return 1;
      return (b.memory_total_bytes || 0) - (a.memory_total_bytes || 0);
    });
  }, [performance]);
  const gpuProfile = performance?.profile?.gpu || null;

  const gpuSummary = useMemo(() => {
    if (gpuItems.length > 0) {
      return gpuItems[0];
    }
    
    if (gpuProfile) {
      const device = gpuProfile.devices?.[0] || {};
      // Utiliser directement les valeurs numériques, pas de parsing de texte
      const totalBytes = Number.isFinite(Number(device.adapter_ram_bytes))
        ? Number(device.adapter_ram_bytes)
        : null;
      
      return {
        id: 'gpu-profile',
        type: 'gpu',
        vendor: gpuProfile.vendor || device.name || gpuProfile.label || 'GPU',
        model: gpuProfile.label || device.name || 'GPU',
        usage_percent: null,
        memory_total_bytes: totalBytes ?? 0,
        memory_used_bytes: null,
        driver: device.driver_version || null,
      };
    }
    
    // Fallback vers WebGPU si disponible
    if (webgpu) {
      return {
        id: 'webgpu',
        type: 'gpu',
        vendor: 'WebGPU',
        model: 'Navigateur',
        usage_percent: null,
        memory_total_bytes: 0,
        memory_used_bytes: null,
        driver: null,
      };
    }
    
    return null;
  }, [gpuItems, gpuProfile, webgpu]);

  const memoryInfo = useMemo(() => {
    const hostTotal = performance?.memory?.TotalBytes ?? performance?.memory?.host_total_bytes ?? performance?.memory?.total_bytes ?? null;
    const hostFree = performance?.memory?.FreeBytes ?? performance?.memory?.host_free_bytes ?? performance?.memory?.free_bytes ?? null;
    const hostUsed = performance?.memory?.UsedBytes ?? performance?.memory?.host_used_bytes ?? performance?.memory?.used_bytes ?? (hostTotal != null && hostFree != null ? hostTotal - hostFree : null);
    const memoryUsage = memAvgHistory.length > 0
      ? memAvgHistory.reduce((sum, v) => sum + v, 0) / memAvgHistory.length
      : performance?.memory?.UsedPercent ?? (hostTotal != null && hostUsed != null ? (hostUsed / hostTotal) * 100 : null);
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
  const metricsSource = performance?.source ? String(performance.source) : 'host-metrics';

  return (
    <div className="card performance-card">
      <div className="card-title">💻 Performance</div>
      <p className="card-subtitle">Vue unifiée du CPU, GPU et de la santé du système.</p>
      <div className="performance-source">Source métriques : {metricsSource}</div>

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

        <div className="performance-hero-card memory-card">
          <div className="performance-hero-head">
            <div>
              <div className="performance-hero-label">Mémoire</div>
              <div className="performance-hero-name">Hôte physique</div>
            </div>
            <div className="performance-chip">{memoryUsagePercent != null ? formatPercent(memoryUsagePercent) : '—'}</div>
          </div>
          <div className="performance-meta-row">
            <div className="performance-metric">
              <span>Total</span>
              <strong>{formatBytes(memoryHostTotal)}</strong>
            </div>
            <div className="performance-metric">
              <span>Utilisé</span>
              <strong>{formatBytes(memoryHostUsed)}</strong>
            </div>
          </div>
          <div className="memory-chart">
            <div className="memory-chart-visual" style={{ height: '160px', marginBottom: '12px' }}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="memory-chart-svg" aria-label="Graphique d’usage mémoire">
                <rect x="0" y="0" width="100" height="100" fill="none" />
                {memoryChartPoints && (
                  <polyline
                    points={memoryChartPoints.used}
                    fill="none"
                    stroke="#a855f7"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="memory-chart-line memory-chart-line-used"
                  />
                )}
              </svg>
              <div className="memory-chart-rules">
                {[...Array(4)].map((_, idx) => (
                  <div key={idx} />
                ))}
              </div>
            </div>
          </div>
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
            {gpuSummary?.temperature_celsius != null && (
              <div>
                <span>Température</span>
                <strong>{gpuSummary.temperature_celsius.toFixed(1)} °C</strong>
              </div>
            )}
            {gpuSummary?.power_draw_watts != null && (
              <div>
                <span>Puissance</span>
                <strong>{gpuSummary.power_draw_watts.toFixed(1)} W</strong>
              </div>
            )}
          </div>
          <div className="gpu-usage-bar">
            <div className="gpu-usage-track">
              <div className="gpu-usage-fill" style={{ width: `${Math.min(Math.max(gpuSummary?.usage_percent ?? 0, 0), 100)}%` }} />
            </div>
            <span>{gpuSummary?.usage_percent != null ? formatPercent(gpuSummary.usage_percent) : 'Pas de métrique'}</span>
          </div>
          <div className="gpu-chipset-note">
            {gpuSummary ? `Détecté comme ${gpuVendorLabel}${gpuSummary.source ? ` · Source: ${gpuSummary.source}` : ''}` : 'Aucun GPU supporté détecté'}
          </div>
          
          {/* GPUs additionnels si multi-GPU */}
          {gpuItems.length > 1 && (
            <div className="gpu-additional-list" style={{ marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '12px' }}>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginBottom: '8px' }}>GPUs additionnels</div>
              {gpuItems.slice(1).map((gpu, idx) => {
                const vendor = normalizeGpuVendor(gpu.vendor, gpu.model);
                return (
                  <div key={gpu.id || `gpu-extra-${idx}`} className="gpu-additional-item" style={{ marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px' }}>{gpu.model || 'GPU'}</span>
                      <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>{vendor}{gpu.source ? ` · ${gpu.source}` : ''}</span>
                    </div>
                    <div className="gpu-usage-track" style={{ height: '4px' }}>
                      <div className="gpu-usage-fill" style={{ width: `${Math.min(Math.max(gpu.usage_percent ?? 0, 0), 100)}%`, height: '4px' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
                      <span style={{ fontSize: '11px' }}>{gpu.usage_percent != null ? formatPercent(gpu.usage_percent) : '—'}</span>
                      <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>
                        {gpu.memory_used_bytes != null ? `${formatBytes(gpu.memory_used_bytes)} / ${formatBytes(gpu.memory_total_bytes)}` : formatBytes(gpu.memory_total_bytes)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
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
        <div className="hardware-card">
          <div className="hardware-card-title">Profil matériel</div>
          <div className="hardware-card-meta">{performance?.profile?.gpu?.label || performance?.profile?.cpu?.model || '—'}</div>
          <div className="hardware-detail">CPU : {cpuSummary?.model || '—'}</div>
          <div className="hardware-detail">GPU : {gpuSummary?.model || 'Aucun'}</div>
          <div className="hardware-detail">OS profil : {performance?.system?.os_profile || '—'}</div>
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
