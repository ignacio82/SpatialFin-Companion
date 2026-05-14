import Icon from './Icon.jsx';
import Sparkline from './Sparkline.jsx';

export default function StatTile({
  label,
  value,
  unit,
  delta,
  deltaUnit = '%',
  spark,
  sparkColor = '#5fd1ff',
  icon,
  hint,
}) {
  const dir = delta == null ? null : delta >= 0 ? 'up' : 'down';
  return (
    <div className="stat">
      {spark && (
        <Sparkline
          data={spark}
          w={64}
          h={22}
          color={sparkColor}
          fill={sparkColor.replace(')', ',0.18)').replace('rgb(', 'rgba(')}
        />
      )}
      <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon && <Icon name={icon} size={11}/>} {label}
      </div>
      <div className="val">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      <div className="sub">
        {delta != null && delta !== 0 && (
          <span className={`delta ${dir}`}>
            {dir === 'up' ? '▲' : '▼'} {Math.abs(delta)}
            {deltaUnit}
          </span>
        )}
        {hint && <span>{hint}</span>}
      </div>
    </div>
  );
}
