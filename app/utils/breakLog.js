import { appendFileSync, existsSync, readFileSync } from 'node:fs'

function padded (number, width = 2) {
  return String(number).padStart(width, '0')
}

// Local time as 2026-10-13T15:12:03.042+02:00, the format of the GNOME extension's
// ~/.local/state/break-timer/focus.jsonl, so the two logs join on time.
function localTimestamp (date) {
  const offsetMinutes = -date.getTimezoneOffset()
  const offsetSign = offsetMinutes < 0 ? '-' : '+'
  const absoluteOffsetMinutes = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${padded(date.getMonth() + 1)}-${padded(date.getDate())}` +
    `T${padded(date.getHours())}:${padded(date.getMinutes())}:${padded(date.getSeconds())}` +
    `.${padded(date.getMilliseconds(), 3)}` +
    `${offsetSign}${padded(Math.floor(absoluteOffsetMinutes / 60))}:${padded(absoluteOffsetMinutes % 60)}`
}

function minutesToOneDecimal (milliseconds) {
  return Math.round(milliseconds / 6000) / 10
}

function secondsToOneDecimal (milliseconds) {
  return Math.round(milliseconds / 100) / 10
}

// With no earlier line there was no earlier run to end badly.
function previousRunEndedCleanly (previousContents) {
  const lastLine = previousContents.trimEnd().split('\n').at(-1)
  if (lastLine === '') return true
  try {
    return JSON.parse(lastLine).event === 'quit'
  } catch {
    return false
  }
}

// record… methods append a line; note… methods only update what later lines report.
export default class BreakLog {
  constructor (logFilePath) {
    this.logFilePath = logFilePath
    this.shownBreak = null
  }

  // breakType is 'mini' or 'long'. Break events and a quit read the popup shown last.
  noteBreakShown ({ breakType }) {
    this.shownBreak = { breakType, shownAt: Date.now() }
  }

  // Called on every close, whether or not the close wrote a line, so a later quit
  // does not report a popup that is gone.
  noteBreakClosed () {
    this.shownBreak = null
  }

  recordTaken () {
    this._appendBreakEvent({ event: 'taken' })
  }

  recordFinishedEarly () {
    this._appendBreakEvent({ event: 'finished_early' })
  }

  // previousPostpones counts this break's postpones before this one.
  recordPostponed ({ previousPostpones }) {
    this._appendBreakEvent({ event: 'postponed', previous_postpones: previousPostpones })
  }

  recordSkippedAhead () {
    this._appendBreakEvent({ event: 'skipped_ahead' })
  }

  recordStart () {
    const previousContents = existsSync(this.logFilePath) ? readFileSync(this.logFilePath, 'utf8') : ''
    // A run killed mid-write leaves a line without its newline; end it so the start line stays whole.
    if (previousContents !== '' && !previousContents.endsWith('\n')) {
      appendFileSync(this.logFilePath, '\n')
    }
    this._append({ event: 'start', previous_run_ended_cleanly: previousRunEndedCleanly(previousContents) })
  }

  // millisecondsToNextBreak is null while paused or during a break.
  recordQuit ({ millisecondsToNextBreak }) {
    const fields = {
      event: 'quit',
      minutes_to_next_break: millisecondsToNextBreak === null
        ? null
        : minutesToOneDecimal(millisecondsToNextBreak)
    }
    if (this.shownBreak) {
      this._appendBreakEvent(fields)
    } else {
      this._append(fields)
    }
  }

  // pauseMilliseconds is null for an indefinite pause.
  recordPaused ({ scheduledBreakType, pauseMilliseconds }) {
    this._appendScheduleEvent({
      event: 'paused',
      pause_minutes: pauseMilliseconds === null ? null : minutesToOneDecimal(pauseMilliseconds)
    }, scheduledBreakType)
  }

  recordReset ({ scheduledBreakType }) {
    this._appendScheduleEvent({ event: 'reset' }, scheduledBreakType)
  }

  // stretchly clears the schedule for idle only while no popup shows.
  recordNaturalBreakCleared ({ scheduledBreakType }) {
    this._append({ event: 'natural_break_cleared', break_type: scheduledBreakType })
  }

  recordNaturalBreakRestarted ({ idleMilliseconds }) {
    this._append({ event: 'natural_break_restarted', idle_seconds: Math.round(idleMilliseconds / 1000) })
  }

  // A popup showing is the break acted on; otherwise it is the break scheduled next.
  _appendScheduleEvent (fields, scheduledBreakType) {
    if (this.shownBreak) {
      this._appendBreakEvent(fields)
    } else {
      this._append({ ...fields, break_type: scheduledBreakType })
    }
  }

  // Nulls mark a call stretchly made with no popup on record; the event itself still counts.
  _appendBreakEvent (fields) {
    this._append({
      ...fields,
      break_type: this.shownBreak?.breakType ?? null,
      seconds_shown: this.shownBreak ? secondsToOneDecimal(Date.now() - this.shownBreak.shownAt) : null
    })
  }

  _append (fields) {
    appendFileSync(this.logFilePath, JSON.stringify({ time: localTimestamp(new Date()), ...fields }) + '\n')
  }
}
