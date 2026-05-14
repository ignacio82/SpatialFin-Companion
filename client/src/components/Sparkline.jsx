export default function Sparkline({
  data,
  w = 60,
  h = 22,
  color = '#5fd1ff',
  fill = 'rgba(0,164,220,0.18)',
  stroke = 1.6,
}) {
  if (!data || data.length === 0) return <svg width={w} height={h}/>;
  const max = Math.max(...data, 1);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const pts = data.map((v, i) => [i * step, h - ((v - min) / range) * (h - 2) - 1]);
  const path = pts
    .map((pt, i) => (i === 0 ? 'M' : 'L') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1))
    .join(' ');
  const lastX = (data.length - 1) * step;
  const area = path + ` L ${lastX} ${h} L 0 ${h} Z`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="spark">
      <path d={area} fill={fill}/>
      <path d={path} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx={lastX} cy={pts[pts.length - 1][1]} r={1.8} fill={color}/>
    </svg>
  );
}
