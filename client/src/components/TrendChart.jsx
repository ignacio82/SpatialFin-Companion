import { useState } from 'react';

export default function TrendChart({ data, height = 220 }) {
  const w = 1000;
  const h = height;
  const padL = 40,
    padR = 40,
    padT = 16,
    padB = 32;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const safeData = data && data.length > 0 ? data : [];
  const xs = (i) =>
    padL + (safeData.length > 1 ? (i / (safeData.length - 1)) * iw : iw / 2);
  const maxMin = Math.max(...safeData.map((d) => d.minutes), 1);
  const maxSes = Math.max(...safeData.map((d) => d.sessions), 1);
  const yMin = (v) => padT + ih - (v / maxMin) * ih;
  const yMaxSes = (v) => padT + ih - (v / maxSes) * ih;
  const linePath = safeData
    .map((d, i) => (i === 0 ? 'M' : 'L') + xs(i) + ' ' + yMin(d.minutes))
    .join(' ');
  const areaPath = safeData.length
    ? linePath + ` L ${xs(safeData.length - 1)} ${padT + ih} L ${xs(0)} ${padT + ih} Z`
    : '';
  const barW = Math.max(2, (iw / Math.max(safeData.length, 1)) * 0.45);

  const ticks = 4;
  const tickVals = Array.from({ length: ticks + 1 }, (_, i) =>
    Math.round((maxMin / ticks) * i)
  );

  const [hover, setHover] = useState(null);

  if (!safeData.length) {
    return <div className="empty">No data in this range yet.</div>;
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: h }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="mins-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#5fd1ff" stopOpacity="0.42"/>
            <stop offset="100%" stopColor="#5fd1ff" stopOpacity="0"/>
          </linearGradient>
          <linearGradient id="bar-grad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#ffba6f" stopOpacity="0.95"/>
            <stop offset="100%" stopColor="#c97712" stopOpacity="0.55"/>
          </linearGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="1.6"/>
          </filter>
        </defs>
        {tickVals.map((v, i) => {
          const y = yMin(v);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="rgba(255,255,255,0.05)"/>
              <text
                x={padL - 6}
                y={y + 3}
                fontSize="9"
                textAnchor="end"
                fill="rgba(180,195,215,0.45)"
                fontWeight="600"
              >
                {v}m
              </text>
            </g>
          );
        })}
        {safeData.map((d, i) => {
          if (i % Math.max(1, Math.floor(safeData.length / 6)) !== 0 && i !== safeData.length - 1)
            return null;
          return (
            <text
              key={i}
              x={xs(i)}
              y={h - 10}
              fontSize="9"
              textAnchor="middle"
              fill="rgba(180,195,215,0.45)"
              fontWeight="600"
            >
              {(d.date || '').slice(5)}
            </text>
          );
        })}

        {safeData.map((d, i) => {
          const y = yMaxSes(d.sessions);
          const hh = padT + ih - y;
          return (
            <rect
              key={'b' + i}
              x={xs(i) - barW / 2}
              y={y}
              width={barW}
              height={hh}
              fill="url(#bar-grad)"
              rx="1.5"
              opacity={hover != null && hover !== i ? 0.35 : 1}
            />
          );
        })}

        <path d={areaPath} fill="url(#mins-area)"/>
        <path
          d={linePath}
          stroke="#5fd1ff"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="url(#glow)"
        />
        <path
          d={linePath}
          stroke="#cfeeff"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {safeData.map((d, i) => (
          <rect
            key={'h' + i}
            x={xs(i) - iw / safeData.length / 2}
            y={padT}
            width={iw / safeData.length}
            height={ih}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
        {hover != null && (
          <g>
            <line
              x1={xs(hover)}
              y1={padT}
              x2={xs(hover)}
              y2={padT + ih}
              stroke="rgba(95,209,255,0.5)"
              strokeDasharray="2 3"
            />
            <circle
              cx={xs(hover)}
              cy={yMin(safeData[hover].minutes)}
              r="3.5"
              fill="#fff"
              stroke="#5fd1ff"
              strokeWidth="1.6"
            />
          </g>
        )}
      </svg>
      {hover != null && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: `min(calc(100% - 160px), max(0px, calc(${
              (hover / Math.max(1, safeData.length - 1)) * 100
            }% - 70px)))`,
            background: 'rgba(8,14,22,0.95)',
            border: '1px solid var(--stroke-2)',
            borderRadius: 8,
            padding: '8px 10px',
            boxShadow: 'var(--elev-2)',
            fontSize: 11,
            color: 'var(--t-1)',
            minWidth: 140,
            pointerEvents: 'none',
          }}
        >
          <div style={{ color: 'var(--t-3)', fontSize: 10, marginBottom: 4, letterSpacing: '0.08em' }}>
            {safeData[hover].date}
          </div>
          <div className="row between" style={{ marginBottom: 2 }}>
            <span style={{ color: 'var(--t-2)' }}>
              <span className="dot teal" style={{ marginRight: 6 }}/>Minutes
            </span>
            <span className="tnum" style={{ fontWeight: 700, color: 'var(--t-0)' }}>
              {safeData[hover].minutes}
            </span>
          </div>
          <div className="row between">
            <span style={{ color: 'var(--t-2)' }}>
              <span
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: 50,
                  background: '#ffba6f',
                  marginRight: 6,
                }}
              />
              Sessions
            </span>
            <span className="tnum" style={{ fontWeight: 700, color: 'var(--t-0)' }}>
              {safeData[hover].sessions}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
