import { existsSync, readFileSync } from 'node:fs'
import log from 'electron-log/main.js'
import { breakLogBreakTypes, breakLogEvents } from './breakLog.js'
import { todaysFocusUsage } from './focusLogSummary.js'

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

function elapsedSince (line, sinceStart) {
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
    if (isRealBreak(line)) return elapsedSince(line, false)
    if (line.event === breakLogEvents.start) return elapsedSince(line, true)
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

// The counts read every line since local midnight, so a restart of stretchly keeps them.
export function longBreakWindowText ({ logFilePath, focusLogPath }) {
  const lines = parsedLines(logFilePath)
  const sinceLastBreak = timeSinceLastBreak(lines)
  const midnight = startOfToday()
  const todaysLines = lines.filter(line => new Date(line.time).getTime() >= midnight)
  const breaksTaken = todaysLines.filter(isRealBreak).length
  const postponed = todaysLines.filter(line => line.event === breakLogEvents.postponed).length
  const breakCounts = `${countText(breaksTaken, 'break')} taken · ${postponed} postponed`
  const headline = sinceLastBreak === null ? '' : sinceLastBreakText(sinceLastBreak)
  const usage = todaysFocusUsage({
    focusLogPath, midnight, lastBreakEnded: sinceLastBreak === null ? null : sinceLastBreak.since
  })
  if (usage.warning) return [headline, `Today: ${breakCounts}`, { warning: usage.warning }]
  return [headline, `Today: ${usage.activeTime} active · ${breakCounts}`, { entries: usage.entries }]
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
