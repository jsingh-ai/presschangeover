import { useEffect, useState } from 'react'
import {
  createCustomRange,
  createPresetRange,
  defaultCustomValues,
  formatSelectedRange,
  RangeValidationError,
  type SelectedRange,
} from '../time-ranges'

interface RangeControlsProps {
  range: SelectedRange
  onChange(range: SelectedRange): void
}

export function RangeControls({ range, onChange }: RangeControlsProps) {
  const defaults = defaultCustomValues()
  const [customFrom, setCustomFrom] = useState(
    range.customFromLocal ?? defaults.from,
  )
  const [customTo, setCustomTo] = useState(range.customToLocal ?? defaults.to)
  const [error, setError] = useState<string>()
  const [customOpen, setCustomOpen] = useState(range.preset === 'custom')

  useEffect(() => {
    if (range.preset === 'custom') setCustomOpen(true)
  }, [range.preset])

  function selectPreset(preset: 'today' | 'last24') {
    setError(undefined)
    setCustomOpen(false)
    onChange(createPresetRange(preset))
  }

  function applyCustom() {
    try {
      const nextRange = createCustomRange(customFrom, customTo)
      setError(undefined)
      setCustomOpen(false)
      onChange(nextRange)
    } catch (caught) {
      setError(
        caught instanceof RangeValidationError
          ? caught.message
          : 'The custom range is invalid.',
      )
    }
  }

  return (
    <section className="range-bar" aria-label="Operational time range">
      <div className="range-choice-row">
        <div className="range-presets" role="group" aria-label="Time range choices">
        <button
          className={range.preset === 'today' ? 'range-button active' : 'range-button'}
          type="button"
          aria-pressed={range.preset === 'today'}
          onClick={() => selectPreset('today')}
        >
          Today
        </button>
        <button
          className={range.preset === 'last24' ? 'range-button active' : 'range-button'}
          type="button"
          aria-pressed={range.preset === 'last24'}
          onClick={() => selectPreset('last24')}
        >
          Last 24 Hours
        </button>
        <button
          className={range.preset === 'custom' ? 'range-button active' : 'range-button'}
          type="button"
          aria-pressed={range.preset === 'custom'}
          aria-expanded={customOpen}
          aria-controls="custom-range-controls"
          onClick={() => { setCustomOpen((open) => !open); setError(undefined) }}
        >
          Custom
        </button>
        </div>
        {customOpen && <div className="custom-range" id="custom-range-controls">
          <label>
            <span>From</span>
            <input
              type="datetime-local"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="datetime-local"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
            />
          </label>
          <button className="range-button custom-apply-button" type="button" onClick={applyCustom}>
            Apply range
          </button>
        </div>}
        <div className="selected-range">
          <strong>{range.preset === 'custom' ? 'Custom range' : range.preset === 'today' ? 'Today' : 'Last 24 hours'}</strong>
          <span>{formatSelectedRange(range)}</span>
        </div>
      </div>
      {error && <p className="range-error" role="alert">{error}</p>}
    </section>
  )
}
