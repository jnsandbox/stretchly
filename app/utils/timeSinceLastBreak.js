import { existsSync, readFileSync } from 'node:fs'
import log from 'electron-log/main.js'
import { breakLogBreakTypes, breakLogEvents } from './breakLog.js'

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

function minutesSince (logTime) {
  return Math.floor((Date.now() - new Date(logTime).getTime()) / 60000)
}

function minutesText (minutes) {
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

function isRealBreak (line) {
  return realBreakEvents.has(line.event) &&
    !(line.event === breakLogEvents.taken && line.break_type === breakLogBreakTypes.mini)
}

// Reads the break log back for when the user last rested, counting from this run's
// start when no real break has ended since. Returns { minutes, sinceStart }, or null
// when the log holds no start line.
export function readTimeSinceLastBreak (logFilePath) {
  const lines = parsedLines(logFilePath)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (isRealBreak(line)) return { minutes: minutesSince(line.time), sinceStart: false }
    if (line.event === breakLogEvents.start) return { minutes: minutesSince(line.time), sinceStart: true }
  }
  return null
}

// secondsText is stretchly's own lead-time text, kept when the lead time is not whole minutes.
export function longBreakWarning ({ leadMilliseconds, secondsText, logFilePath }) {
  const firstSentence = leadMilliseconds > 0 && leadMilliseconds % 60000 === 0
    ? `Long break in ${minutesText(leadMilliseconds / 60000)}.`
    : `${secondsText}.`
  const timeSinceLastBreak = readTimeSinceLastBreak(logFilePath)
  if (timeSinceLastBreak === null) return firstSentence
  const since = timeSinceLastBreak.sinceStart ? 'since you started' : 'since your last break'
  return `${firstSentence} ${minutesText(timeSinceLastBreak.minutes)} ${since}.`
}
