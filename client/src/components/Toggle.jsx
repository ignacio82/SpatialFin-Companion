export default function Toggle({ on, onChange, disabled }) {
  return (
    <label
      className={'toggle ' + (on ? 'on' : '')}
      style={{ opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
      onClick={(e) => {
        e.preventDefault();
        if (disabled) return;
        onChange && onChange(!on);
      }}
    >
      <input type="checkbox" checked={!!on} readOnly disabled={disabled}/>
      <span className="track"/>
      <span className="knob"/>
    </label>
  );
}
