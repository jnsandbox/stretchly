import { existsSync, readFileSync } from 'node:fs'
import { breakLogBreakTypes, breakLogEvents } from './breakLog.js'
import { lineTime, parsedLogLine } from './logLines.js'
import { todaysFocusUsage } from './focusLogSummary.js'

// The lines on which stretchly restarts its schedule after the user rested. A lock
// or suspend writes away_break only when it lasted long enough to count.
const realBreakEvents = new Set([
  breakLogEvents.taken, breakLogEvents.naturalBreakRestarted, breakLogEvents.awayBreak
])

// A skipped line could hide a real break, so it is reported rather than passed over.
function parsedLines (logFilePath) {
  if (!existsSync(logFilePath)) return []
  return readFileSync(logFilePath, 'utf8').split('\n').flatMap((text, index) => {
    if (text === '') return []
    const line = parsedLogLine(text, `break log line ${index + 1} of ${logFilePath}`)
    return line === null ? [] : [line]
  })
}

function elapsedSince (line, sinceStart) {
  const since = lineTime(line)
  return { since, minutes: Math.floor((Date.now() - since) / 60000), sinceStart }
}

function countText (count, singularNoun) {
  return count === 1 ? `1 ${singularNoun}` : `${count} ${singularNoun}s`
}

function isRealBreak (line) {
  return realBreakEvents.has(line.event) &&
    !(line.event === breakLogEvents.taken && line.break_type === breakLogBreakTypes.mini)
}

// When the user last rested, counting from this run's start when no real break has ended
// since. Returns { since, minutes, sinceStart }, since in epoch milliseconds, or null when
// the log holds no start line.
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
// focusLogPath defaults to the focus-log extension's own log.
export function longBreakWindowText ({ logFilePath, focusLogPath }) {
  const lines = parsedLines(logFilePath)
  const sinceLastBreak = timeSinceLastBreak(lines)
  const midnight = startOfToday()
  const todaysLines = lines.filter(line => lineTime(line) >= midnight)
  const breaksTaken = todaysLines.filter(isRealBreak).length
  const postponed = todaysLines.filter(line => line.event === breakLogEvents.postponed).length
  const breakCounts = `${countText(breaksTaken, 'break')} taken · ${postponed} postponed`
  const headline = sinceLastBreak === null ? '' : sinceLastBreakText(sinceLastBreak)
  const usage = todaysFocusUsage({
    focusLogPath, midnight, lastBreakEnded: sinceLastBreak === null ? null : sinceLastBreak.since
  })
  if (usage.warning) return { headline, todayLine: `Today: ${breakCounts}`, usage: { warning: usage.warning } }
  return { headline, todayLine: `Today: ${usage.activeTime} active · ${breakCounts}`, usage: { entries: usage.entries } }
}

// secondsText is stretchly's own lead-time text, kept when the lead time is not whole minutes.
export function longBreakWarning ({ leadMilliseconds, secondsText, logFilePath }) {
  const firstSentence = leadMilliseconds > 0 && leadMilliseconds % 60000 === 0
    ? `Long break in ${countText(leadMilliseconds / 60000, 'minute')}.`
    : `${secondsText}.`
  const sinceLastBreak = timeSinceLastBreak(parsedLines(logFilePath))
  if (sinceLastBreak === null) return firstSentence
  return `${firstSentence} ${sinceLastBreakText(sinceLastBreak)}.`
}
