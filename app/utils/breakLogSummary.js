import { existsSync, readFileSync } from 'node:fs'
import log from 'electron-log/main.js'
import { breakLogBreakTypes, breakLogEvents } from './breakLog.js'
import { activeSecondsPerWindow, durationText, listedUsage, readFocusLogSince } from './focusLogSummary.js'

// The lines on which stretchly restarts its schedule after the user rested. A lock
// or suspend writes away_break only when it lasted long enough to count.
const realBreakEvents = new Set([
  breakLogEvents.taken, breakLogEvents.naturalBreakRestarted, breakLogEvents.awayBreak
])

// A skipped line could hide a real break, so it is reported rather than passed over.
function parsedLines (logFilePath) {
  if (!existsSync(logFilePath)) return []
  return readFileSync(logFilePath, 'utf8').split('\n').flatMap((line, index) => {
    if (line === '') return []
    try {
      return [JSON.parse(line)]
    } catch (error) {
      log.warn(`Stretchly: cannot read break log line ${index + 1} of ${logFilePath}: ${error.message}`)
      return []
    }
  })
}

function sinceLine (line, sinceStart) {
  const since = new Date(line.time).getTime()
  return { since, minutes: Math.floor((Date.now() - since) / 60000), sinceStart }
}

function countText (count, singularNoun) {
  return count === 1 ? `1 ${singularNoun}` : `${count} ${singularNoun}s`
}

function isRealBreak (line) {
  return realBreakEvents.has(line.event) &&
    !(line.event === breakLogEvents.taken && line.break_type === breakLogBreakTypes.mini)
}

// Reads the break log back for when the user last rested, counting from this run's
// start when no real break has ended since. Returns { since, minutes, sinceStart },
// since in epoch milliseconds, or null when the log holds no start line.
export function readTimeSinceLastBreak (logFilePath) {
  return timeSinceLastBreak(parsedLines(logFilePath))
}

function timeSinceLastBreak (lines) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (isRealBreak(line)) return sinceLine(line, false)
    if (line.event === breakLogEvents.start) return sinceLine(line, true)
  }
  return null
}

function sinceLastBreakText ({ minutes, sinceStart }) {
  return `${countText(minutes, 'minute')} ${sinceStart ? 'since you started' : 'since your last break'}`
}

function startOfToday () {
  const midnight = new Date(Date.now())
  midnight.setHours(0, 0, 0, 0)
  return midnight.getTime()
}

function clockText (epochMilliseconds) {
  const time = new Date(epochMilliseconds)
  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
}

// The extension writes at least an idle line within any stretch of work as long as a
// break interval, so silence since the last break means it stopped, not a quiet day.
function staleFocusLogWarning (focusLog, sinceLastBreak, midnight) {
  const question = 'Is the focus-log extension running?'
  if (focusLog.lastLineTime === null || focusLog.lastLineTime < midnight) return `No window data today. ${question}`
  if (sinceLastBreak !== null && focusLog.lastLineTime < sinceLastBreak.since) {
    return `No window data since ${clockText(focusLog.lastLineTime)}. ${question}`
  }
  return null
}

// Returns the long break window's title, its today line, and where today's active
// time went. The counts read every line since local midnight, so a restart of
// stretchly keeps them.
export function longBreakWindowText ({ logFilePath, focusLogPath }) {
  const lines = parsedLines(logFilePath)
  const sinceLastBreak = timeSinceLastBreak(lines)
  const midnight = startOfToday()
  const todaysLines = lines.filter(line => new Date(line.time).getTime() >= midnight)
  const breaksTaken = todaysLines.filter(isRealBreak).length
  const postponed = todaysLines.filter(line => line.event === breakLogEvents.postponed).length
  const breakCounts = `${countText(breaksTaken, 'break')} taken · ${postponed} postponed`
  const headline = sinceLastBreak === null ? '' : sinceLastBreakText(sinceLastBreak)
  const focusLog = readFocusLogSince(focusLogPath, midnight)
  const focusLogWarning = staleFocusLogWarning(focusLog, sinceLastBreak, midnight)
  if (focusLogWarning !== null) return [headline, `Today: ${breakCounts}`, { warning: focusLogWarning }]
  const windows = activeSecondsPerWindow(focusLog.lines, { from: midnight, until: Date.now() })
  const activeSeconds = windows.reduce((total, window) => total + window.seconds, 0)
  return [headline, `Today: ${durationText(activeSeconds)} active · ${breakCounts}`, { entries: listedUsage(windows) }]
}

// secondsText is stretchly's own lead-time text, kept when the lead time is not whole minutes.
export function longBreakWarning ({ leadMilliseconds, secondsText, logFilePath }) {
  const firstSentence = leadMilliseconds > 0 && leadMilliseconds % 60000 === 0
    ? `Long break in ${countText(leadMilliseconds / 60000, 'minute')}.`
    : `${secondsText}.`
  const timeSinceLastBreak = readTimeSinceLastBreak(logFilePath)
  if (timeSinceLastBreak === null) return firstSentence
  return `${firstSentence} ${sinceLastBreakText(timeSinceLastBreak)}.`
}
