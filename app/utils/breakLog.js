import { appendFileSync, existsSync, readFileSync } from 'node:fs'

function twoDigits (number) {
  return String(number).padStart(2, '0')
}

// Local time as 2026-10-13T15:12:03.042+02:00, the focus log's format, so the two logs join on time.
function localTimestamp (date) {
  const offsetMinutes = -date.getTimezoneOffset()
  const offsetSign = offsetMinutes < 0 ? '-' : '+'
  const absoluteOffsetMinutes = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}` +
    `T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}` +
    `.${String(date.getMilliseconds()).padStart(3, '0')}` +
    `${offsetSign}${twoDigits(Math.floor(absoluteOffsetMinutes / 60))}:${twoDigits(absoluteOffsetMinutes % 60)}`
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
        : Math.round(millisecondsToNextBreak / 6000) / 10
    })
  }

  _append (fields) {
    appendFileSync(this.logFilePath, JSON.stringify({ time: localTimestamp(new Date()), ...fields }) + '\n')
  }
}
