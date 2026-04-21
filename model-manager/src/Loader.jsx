import { useEffect, useRef, useState } from 'react';

function Loader({ show, progress = 0 }) {
  const animationRef = useRef(null);
  const offsetRef = useRef(0);
  const [letterIndex, setLetterIndex] = useState(0);

  useEffect(() => {
    if (show) {
      const animate = () => {
        offsetRef.current += 2;
        const offset = offsetRef.current;
        if (offset % 25 < 1 && letterIndex < 'Chargement...'.length) {
          setLetterIndex(l => l + 1);
        }
        animationRef.current = requestAnimationFrame(animate);
      };
      animate();
    } else {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      setLetterIndex(0);
    }
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [show]);

  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape' && show) {
        window.dispatchEvent(new CustomEvent('hideLoader'));
      }
    };
    if (show) document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [show]);

  if (!show) return null;

  const barCount = 55;
  const center = barCount / 2;
  const filledCount = progress > 0 ? Math.round((progress / 100) * barCount) : 0;
  const isIndeterminate = progress <= 0;
  const titleText = 'Chargement...'.slice(0, letterIndex) + (letterIndex < 'Chargement...'.length ? '|' : '');

  const offset = offsetRef.current;
  const breathe = (Math.sin(offset * 0.01) + 1) / 2;
  const pulsePhase = offset * 0.15;

  return (
    <>
      <div 
        className="loader-backdrop" 
        style={{ 
          backgroundColor: 'rgba(7, 17, 31, 0.95)',
          backdropFilter: 'blur(12px)'
        }} 
      />
      <div className="loader-overlay">
        <div className="loader-content">
          <div 
            style={{
              fontSize: '48px',
              color: '#f1f5f9',
              marginBottom: '40px',
              fontWeight: 300,
              letterSpacing: '4px',
              textShadow: `0 0 15px rgba(20, 184, 166, 0.6)`,
              transform: `scale(${1 + breathe * 0.03})`,
              opacity: Math.min(letterIndex / 12, 1)
            }}
          >
            {titleText}
          </div>

          <div 
            style={{
              position: 'relative',
              width: '100%',
              height: '120px',
              borderRadius: '60px',
              border: '4px solid #14b8a6',
              backgroundColor: 'rgba(20, 184, 166, 0.08)',
              overflow: 'hidden',
              padding: '0 20px',
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              boxShadow: `0 0 25px rgba(20, 184, 166, ${breathe * 0.4})`
            }}
          >
            {/* Shimmer pour progress */}
            {progress > 0 && (
              <div 
                style={{
                  position: 'absolute',
                  top: 0, left: 0, right: 0, bottom: 0,
                  background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.3) 50%, transparent 100%)',
                  transform: `translateX(${(offset * 0.8) % 400 - 200}px)`,
                }}
              />
            )}

            {Array.from({ length: barCount }).map((_, i) => {
              const distance = Math.abs(i - center);
              const spread = 12;
              const gaussPulse = Math.exp(-distance * distance / (spread * spread));
              let opacity;

              if (isIndeterminate) {
                const phase = pulsePhase + (i - center) * 0.3;
                opacity = 0.2 + gaussPulse * 0.6 * (0.5 + 0.5 * Math.sin(phase));
              } else {
                const isFilled = i < filledCount;
                const phase = pulsePhase + (i - center) * 0.25;
                opacity = isFilled ? 0.35 + gaussPulse * 0.45 * (0.6 + 0.4 * Math.sin(phase)) : 0.12;
              }

              const heightScale = 0.7 + breathe * 0.12 + gaussPulse * 0.08;

              return (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    height: `${heightScale * 100}%`,
                    backgroundColor: `rgba(20, 184, 166, ${opacity})`,
                    borderRadius: '4px',
                    transition: isIndeterminate ? 'none' : 'all 0.25s cubic-bezier(0.68, -0.55, 0.265, 1.55)'
                  }}
                />
              );
            })}
          </div>

          <div style={{
            marginTop: '30px',
            color: '#9ca3af',
            fontSize: '20px',
            opacity: 0.9
          }}>
            {progress > 0 ? `Progression: ${Math.round(progress)}%` : 'Veuillez patienter...'}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.7; }
          50% { opacity: 1; }
        }
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .loader-content {
          animation: subtleGlow 2.5s ease-in-out infinite alternate;
        }
        @keyframes subtleGlow {
          0% { box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
          100% { box-shadow: 0 25px 50px rgba(20,184,166,0.15); }
        }
      `}</style>
    </>
  );
}

export default Loader;

