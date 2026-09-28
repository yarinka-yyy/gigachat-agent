export default function ContextRing({ percent, compact = false }: { percent?: number; compact?: boolean }) {
  const value = percent === undefined ? null : Math.max(0, Math.min(100, percent));
  return (
    <svg className={`context-ring-graphic${compact ? ' is-compact' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle className="context-ring-track" cx="12" cy="12" r="9" fill="none" strokeWidth="4" />
      {value !== null && <circle className="context-ring-fill" cx="12" cy="12" r="9" fill="none" strokeWidth="4"
        pathLength="100" strokeDasharray="100" strokeDashoffset={100 - value} transform="rotate(-90 12 12)" />}
    </svg>
  );
}
