import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'path'
import log from 'electron-log/main.js'
import { lineTime, padded, parsedLogLine } from './logLines.js'

// VS Code reports either app ID, depending on how it was installed.
const vsCodeAppIds = new Set(['code.desktop', 'com.microsoft.VSCode.desktop'])
const remoteLabelPrefixes = ['SSH: ', 'Dev Container: ']
const unattributed = '(unattributed)'
const braveAppId = 'brave-browser.desktop'
const braveOwnEntrySeconds = 15 * 60
// Sites whose pages each carry their own title, so only the site as a whole adds up.
const braveSites = [
  { name: 'Mattermost', matches: pageTitle => pageTitle.endsWith('Mattermost') },
  // GitLab issue pages leave the site's name out of the title.
  { name: 'GitLab', matches: pageTitle => pageTitle.endsWith('· GitLab') || pageTitle.includes(' · Issue · ') || pageTitle.startsWith('gitlab.') },
  { name: 'Jitsi', matches: pageTitle => pageTitle.includes('Jitsi Meet') || pageTitle.startsWith('jitsi.') }
]
const listedEntryCount = 15

const newlineByte = 0x0a
const extensionQuestion = 'Is the focus-log extension running?'

// The extension's default log, in the user's home folder.
const defaultFocusLogPath = join(homedir(), '.local', 'state', 'break-timer', 'focus.jsonl')

const awayStartEvents = { idle_start: 'idle', lock: 'lock', suspend: 'suspend' }
const awayEndEvents = { idle_end: 'idle', unlock: 'lock', resume: 'suspend' }

// The log is never rotated, so it is read backwards, back to the last focus line before
// `since`: that line says which window had focus overnight.
function readFocusLogSince (focusLogPath, since) {
  const missing = { lines: [], lastLineTime: null }
  if (!existsSync(focusLogPath)) return missing
  try {
    return readExistingFocusLogSince(focusLogPath, since)
  } catch (error) {
    // The break window must still open, so an unreadable log reads as a missing one.
    log.warn(`Stretchly: cannot read focus log ${focusLogPath}: ${error.message}`)
    return missing
  }
}

function readExistingFocusLogSince (focusLogPath, since) {
  const chunkBytes = 65536
  const file = openSync(focusLogPath, 'r')
  try {
    let position = fstatSync(file).size
    let unread = Buffer.alloc(0)
    const linesNewestFirst = []
    let lastLineTime = null
    let foundFocusBeforeSince = false
    while (!foundFocusBeforeSince && position > 0) {
      const readBytes = Math.min(chunkBytes, position)
      position -= readBytes
      const chunk = Buffer.alloc(readBytes)
      readSync(file, chunk, 0, readBytes, position)
      unread = Buffer.concat([chunk, unread])
      // Until the file's start is reached, the text before the first newline may be a partial line.
      const firstCompleteLine = position > 0 ? unread.indexOf(newlineByte) + 1 : 0
      if (position > 0 && firstCompleteLine === 0) continue
      const texts = unread.subarray(firstCompleteLine).toString('utf8').split('\n')
      unread = unread.subarray(0, firstCompleteLine)
      for (let index = texts.length - 1; index >= 0; index--) {
        if (texts[index] === '') continue
        const line = parsedLogLine(texts[index], `focus log line in ${focusLogPath}`)
        if (line === null) continue
        if (lastLineTime === null) lastLineTime = lineTime(line)
        linesNewestFirst.push(line)
        if (lineTime(line) < since && line.event === 'focus') {
          foundFocusBeforeSince = true
          break
        }
      }
    }
    return { lines: linesNewestFirst.reverse(), lastLineTime }
  } finally {
    closeSync(file)
  }
}

// Lines before `from` only set the state: a stretch that starts before midnight counts
// for the day before, even the part of it after midnight.
function activeSecondsPerWindow (lines, { from, until }) {
  const secondsPerWindow = new Map()
  const openAway = new Set()
  let focused = null
  let previousTime = null
  const addStretch = (endTime) => {
    if (previousTime === null || previousTime < from || focused === null || openAway.size > 0) return
    const key = JSON.stringify([focused.appId, focused.title])
    const focusedWindow = secondsPerWindow.get(key) || { appId: focused.appId, title: focused.title, seconds: 0 }
    focusedWindow.seconds += (endTime - previousTime) / 1000
    secondsPerWindow.set(key, focusedWindow)
  }
  for (const line of lines) {
    const time = lineTime(line)
    addStretch(time)
    previousTime = time
    if (line.event === 'focus') {
      if (line.window_id === null) {
        focused = null
      } else if (focused === null || line.window_id !== focused.windowId) {
        focused = { windowId: line.window_id, appId: line.app_id, title: line.title }
      }
    } else if (line.event === 'title') {
      if (focused !== null && line.window_id === focused.windowId) focused.title = line.title
    } else if (awayStartEvents[line.event]) {
      openAway.add(awayStartEvents[line.event])
    } else if (awayEndEvents[line.event]) {
      openAway.delete(awayEndEvents[line.event])
    }
  }
  addStretch(until)
  return [...secondsPerWindow.values()]
}

function desktopEntryName (appId) {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')
  for (const dataDir of [dataHome, ...dataDirs]) {
    const entryPath = join(dataDir, 'applications', appId)
    if (!existsSync(entryPath)) continue
    const name = readFileSync(entryPath, 'utf8').match(/^Name=(.+)$/m)
    if (name) return name[1].trim()
  }
  return null
}

// Names an app as its desktop entry does, or by the last part of its ID when no entry is found.
function appName (appId, desktopNames) {
  if (!desktopNames.has(appId)) {
    desktopNames.set(appId, desktopEntryName(appId) || appId.replace(/\.desktop$/, '').split('.').pop())
  }
  return desktopNames.get(appId)
}

// Names the workspace a VS Code window title belongs to, remote label included. The
// user's window.title setting puts the remote label and the folder first.
function vsCodeWorkspace (title) {
  if (!title || title === 'Visual Studio Code') return unattributed
  if (title.startsWith('dev-container+')) {
    // While a container connects, the title is the raw remote authority: hex-encoded JSON naming the host folder.
    const hex = (title.match(/^dev-container\+([0-9a-f]+)/) || [null, ''])[1]
    try {
      const authority = JSON.parse(Buffer.from(hex.slice(0, hex.length - hex.length % 2), 'hex').toString('utf8'))
      if (typeof authority.hostPath !== 'string') return unattributed
      return `Dev Container (connecting): ${basename(authority.hostPath)}`
    } catch {
      return unattributed
    }
  }
  const segments = title.split(' - ').filter(segment => segment !== '')
  if (segments.length === 0) return unattributed
  if (remoteLabelPrefixes.some(prefix => segments[0].startsWith(prefix))) {
    return `${segments[0]} / ${segments.length > 1 ? segments[1] : '(no folder)'}`
  }
  return segments[0]
}

// A Brave window's title is its page's, with the browser's suffix and any unread count stripped.
function bravePageTitle (title) {
  return (title || '').replace(/ - Brave$/, '').replace(/^\(\d+\) /, '')
}

function braveEntryName (title) {
  const pageTitle = bravePageTitle(title)
  const site = braveSites.find(candidate => candidate.matches(pageTitle))
  return `Brave · ${site ? site.name : pageTitle}`
}

function entryName (focusedWindow, desktopNames) {
  const { appId, title } = focusedWindow
  if (vsCodeAppIds.has(appId)) return `VS Code · ${vsCodeWorkspace(title)}`
  if (appId === braveAppId) return braveEntryName(title)
  // GNOME gives no app ID to some windows, such as games run through Steam.
  if (appId.startsWith('window:')) return (title || '').trim() || appId
  return appName(appId, desktopNames)
}

function addSeconds (secondsPerEntry, name, seconds) {
  secondsPerEntry.set(name, (secondsPerEntry.get(name) || 0) + seconds)
}

// Ranks the time per entry: one entry per app, with VS Code split by workspace, Brave
// split by site where known, and other Brave pages of 15 minutes or more on their own.
function rankedUsage (windows) {
  const desktopNames = new Map()
  const secondsPerEntry = new Map()
  const secondsPerBravePage = new Map()
  const braveSiteNames = new Set(braveSites.map(site => `Brave · ${site.name}`))
  for (const focusedWindow of windows) {
    const name = entryName(focusedWindow, desktopNames)
    const isBravePage = focusedWindow.appId === braveAppId && !braveSiteNames.has(name)
    addSeconds(isBravePage ? secondsPerBravePage : secondsPerEntry, name, focusedWindow.seconds)
  }
  for (const [name, seconds] of secondsPerBravePage) {
    addSeconds(secondsPerEntry, seconds >= braveOwnEntrySeconds ? name : 'Brave · other tabs', seconds)
  }
  return [...secondsPerEntry].map(([name, seconds]) => ({ name, seconds }))
    .sort((first, second) => second.seconds - first.seconds)
}

// Returns the entries the break window lists: the top 15, then the rest as Other.
function listedUsage (windows) {
  const ranked = rankedUsage(windows)
  const listed = ranked.slice(0, listedEntryCount)
  const rest = ranked.slice(listedEntryCount)
  if (rest.length > 0) listed.push({ name: 'Other', seconds: rest.reduce((total, entry) => total + entry.seconds, 0) })
  return listed.map(({ name, seconds }) => ({ name, duration: durationText(seconds) }))
}

function durationText (seconds) {
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function clockText (epochMilliseconds) {
  const time = new Date(epochMilliseconds)
  return `${padded(time.getHours())}:${padded(time.getMinutes())}`
}

// Within a stretch of work as long as a break interval the extension always writes a
// line, so silence since the last break means it stopped, not a quiet day.
function staleWarning (lastLineTime, midnight, lastBreakEnded) {
  if (lastLineTime === null || lastLineTime < midnight) return `No window data today. ${extensionQuestion}`
  if (lastBreakEnded !== null && lastLineTime < lastBreakEnded) {
    return `No window data since ${clockText(lastLineTime)}. ${extensionQuestion}`
  }
  return null
}

// Returns today's active time and listed entries, or a warning when the log is missing
// or stale. lastBreakEnded is when the last real break or this run started, or null.
export function todaysFocusUsage ({ focusLogPath = defaultFocusLogPath, midnight, lastBreakEnded }) {
  const { lines, lastLineTime } = readFocusLogSince(focusLogPath, midnight)
  const warning = staleWarning(lastLineTime, midnight, lastBreakEnded)
  if (warning !== null) return { warning }
  const windows = activeSecondsPerWindow(lines, { from: midnight, until: Date.now() })
  const activeSeconds = windows.reduce((total, focusedWindow) => total + focusedWindow.seconds, 0)
  return { activeTime: durationText(activeSeconds), entries: listedUsage(windows) }
}
