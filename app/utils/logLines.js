import log from 'electron-log/main.js'

export function padded (number, width = 2) {
  return String(number).padStart(width, '0')
}

// Epoch milliseconds of a parsed log line.
export function lineTime (line) {
  return new Date(line.time).getTime()
}

// A damaged line is reported and passed over, so one bad write does not hide the rest of
// the log. `where` names the line in the warning, its number included when known.
export function parsedLogLine (text, where) {
  try {
    return JSON.parse(text)
  } catch (error) {
    log.warn(`Stretchly: cannot read ${where}: ${error.message}`)
    return null
  }
}
