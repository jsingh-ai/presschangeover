import type { RadiusPressKey, RadiusPressOverview } from '../types/api'

interface Props {
  presses: RadiusPressOverview[]
  selectedPress?: RadiusPressKey
  onSelect(pressKey: RadiusPressKey | undefined): void
  onClear(): void
}

export function PressFilterBar({ presses, selectedPress, onSelect, onClear }: Props) {
  const selected = presses.find(({ pressKey }) => pressKey === selectedPress)
  return <section className={selected ? 'active-filter-bar' : 'active-filter-bar active-filter-bar--all'} aria-label="Press analysis scope">
    <div className="press-scope-buttons" role="group" aria-label="Choose press scope">
      <button type="button" className={!selected ? 'press-scope-button active' : 'press-scope-button'} data-press-key="" aria-pressed={!selected} onClick={onClear}>
        <span className="fleet-button-icon" aria-hidden="true">▦</span>All presses
      </button>
      {presses.map((press) => <button
        type="button"
        key={press.pressKey}
        className={press.pressKey === selectedPress ? 'press-scope-button active' : 'press-scope-button'}
        data-press-key={press.pressKey}
        aria-pressed={press.pressKey === selectedPress}
        aria-label={press.pressKey === selectedPress ? `${press.displayName} selected` : `Analyze ${press.displayName}`}
        onClick={() => onSelect(press.pressKey)}
      >{press.displayName}</button>)}
    </div>
    <span className="scope-note">{selected ? `${selected.displayName} selected` : `Fleet view · ${presses.length} mapped presses`}</span>
  </section>
}
