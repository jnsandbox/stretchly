import { existsSync, readFileSync } from 'node:fs'

// The lines on which stretchly restarts its schedule after the user rested. A lock
// or suspend writes away_break only when it lasted long enough to count.
const realBreakEvents = new Set(['taken', 'natural_break_restarted', 'away_break'])

function parsedLines (logFilePath) {
  if (!existsSync(logFilePath)) return []
  return readFileSync(logFilePath, 'utf8').split('\n').flatMap(line => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

function minutesSince (logTime) {
  return Math.floor((Date.now() - new Date(logTime).getTime()) / 60000)
}

function isRealBreak (line) {
  return realBreakEvents.has(line.event) && !(line.event === 'taken' && line.break_type === 'mini')
}

// Reads the break log back for when the user last rested, counting from this run's
// start when no real break has ended since. Returns { minutes, sinceStart }, or null
// when the log holds no start line.
export function readTimeSinceLastBreak (logFilePath) {
  const lines = parsedLines(logFilePath)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (isRealBreak(line)) return { minutes: minutesSince(line.time), sinceStart: false }
    if (line.event === 'start') return { minutes: minutesSince(line.time), sinceStart: true }
  }
  return null
}

// firstSentence is stretchly's own text, which follows the notification lead time.
export function longBreakWarning (firstSentence, logFilePath) {
  const timeSinceLastBreak = readTimeSinceLastBreak(logFilePath)
  if (timeSinceLastBreak === null) return firstSentence
  const since = timeSinceLastBreak.sinceStart ? 'since you started' : 'since your last break'
  return `${firstSentence} ${timeSinceLastBreak.minutes} minutes ${since}.`
}
