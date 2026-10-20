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

export default class BreakLog {
  constructor (logFilePath) {
    this.logFilePath = logFilePath
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
    this._append({
      event: 'quit',
      minutes_to_next_break: millisecondsToNextBreak === null
        ? null
        : minutesToOneDecimal(millisecondsToNextBreak)
    })
  }

  _append (fields) {
    appendFileSync(this.logFilePath, JSON.stringify({ time: localTimestamp(new Date()), ...fields }) + '\n')
  }
}
