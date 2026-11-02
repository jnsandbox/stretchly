import { vi, expect } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import log from 'electron-log/main.js'
import { longBreakWarning, longBreakWindowText } from '../app/utils/breakLogSummary'

vi.mock('electron-log/main.js', () => ({ default: { warn: vi.fn() } }))

process.env.TZ = 'Europe/Amsterdam'

const twoMinutes = 120000

let logFolder = null
let logFilePath = null
let focusLogPath = null

async function writeLog (lines) {
  await writeFile(logFilePath, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
}

beforeEach(async () => {
  logFolder = await mkdtemp(join(tmpdir(), 'stretchly-break-log-summary-'))
  logFilePath = join(logFolder, 'breaks.jsonl')
  focusLogPath = join(logFolder, 'focus.jsonl')
  // No desktop entries, so app names fall back to the app ID.
  process.env.XDG_DATA_HOME = join(logFolder, 'data')
  process.env.XDG_DATA_DIRS = join(logFolder, 'data-dirs')
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-20T10:00:30.000+02:00'))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.clearAllMocks()
  await rm(logFolder, { recursive: true, force: true })
})

describe('long break warning', () => {
  // secondsText stands in for stretchly's own translated lead-time text.
  function warning (leadMilliseconds = twoMinutes) {
    return longBreakWarning({
      leadMilliseconds,
      secondsText: `Long break in ${leadMilliseconds / 1000} seconds`,
      logFilePath
    })
  }

  it('counts from a long break run to its full length', async () => {
    await writeLog([
      { time: '2026-10-20T08:00:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T09:07:00.000+02:00', event: 'taken', break_type: 'long', seconds_shown: 300 }
    ])
    expect(warning())
      .toBe('Long break in 2 minutes. 53 minutes since your last break.')
  })

  it('counts from the end of a natural break', async () => {
    await writeLog([
      { time: '2026-10-20T08:00:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T09:40:00.000+02:00', event: 'natural_break_restarted', idle_seconds: 400 }
    ])
    expect(warning())
      .toBe('Long break in 2 minutes. 20 minutes since your last break.')
  })

  it('counts from the end of a lock or suspend long enough to be a break', async () => {
    await writeLog([
      { time: '2026-10-20T08:00:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T09:30:00.000+02:00', event: 'away_break', away_seconds: 600, cause: 'lock', break_type: 'long' }
    ])
    expect(warning())
      .toBe('Long break in 2 minutes. 30 minutes since your last break.')
  })

  it('does not count postpones, pauses, early finishes or mini breaks as breaks', async () => {
    await writeLog([
      { time: '2026-10-20T08:00:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T09:00:00.000+02:00', event: 'taken', break_type: 'long', seconds_shown: 300 },
      { time: '2026-10-20T09:10:00.000+02:00', event: 'paused', pause_minutes: 30, break_type: 'long' },
      { time: '2026-10-20T09:40:00.000+02:00', event: 'resumed', paused_minutes: 30 },
      { time: '2026-10-20T09:45:00.000+02:00', event: 'taken', break_type: 'mini', seconds_shown: 20 },
      { time: '2026-10-20T09:50:00.000+02:00', event: 'postponed', previous_postpones: 0, break_type: 'long', seconds_shown: 3 },
      { time: '2026-10-20T09:55:00.000+02:00', event: 'finished_early', break_type: 'long', seconds_shown: 10 }
    ])
    expect(warning())
      .toBe('Long break in 2 minutes. 60 minutes since your last break.')
  })

  it('counts from the start when no break has ended since', async () => {
    await writeLog([
      { time: '2026-10-20T08:00:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T08:30:00.000+02:00', event: 'taken', break_type: 'long', seconds_shown: 300 },
      { time: '2026-10-20T09:00:00.000+02:00', event: 'quit', minutes_to_next_break: 25 },
      { time: '2026-10-20T09:07:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T09:20:00.000+02:00', event: 'away_break', away_seconds: 360, cause: 'suspend', break_type: 'long' },
      { time: '2026-10-20T09:30:00.000+02:00', event: 'start', previous_run_ended_cleanly: false }
    ])
    expect(warning())
      .toBe('Long break in 2 minutes. 30 minutes since you started.')
  })

  it('counts the minutes afresh each time the warning shows', async () => {
    await writeLog([
      { time: '2026-10-20T09:00:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T09:58:00.000+02:00', event: 'postponed', previous_postpones: 0, break_type: 'long', seconds_shown: 3 }
    ])
    expect(warning())
      .toBe('Long break in 2 minutes. 60 minutes since you started.')
    vi.setSystemTime(new Date('2026-10-20T10:08:29.000+02:00'))
    expect(warning())
      .toBe('Long break in 2 minutes. 68 minutes since you started.')
  })

  it('keeps only the first sentence when the log has no start of this run', async () => {
    expect(warning()).toBe('Long break in 2 minutes.')
  })

  it('says a whole number of minutes of lead time in minutes', async () => {
    expect(warning(60000)).toBe('Long break in 1 minute.')
  })

  it('keeps stretchly\'s seconds text for a lead time short of whole minutes', async () => {
    expect(warning(30000)).toBe('Long break in 30 seconds.')
    expect(warning(90000)).toBe('Long break in 90 seconds.')
  })

  it('says a single minute since the last break in the singular', async () => {
    await writeLog([
      { time: '2026-10-20T08:00:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T09:59:00.000+02:00', event: 'natural_break_restarted', idle_seconds: 400 }
    ])
    expect(warning()).toBe('Long break in 2 minutes. 1 minute since your last break.')
  })

  it('warns in the log about a line it cannot read', async () => {
    await writeFile(logFilePath,
      '{"time":"2026-10-20T08:00:00.000+02:00","event":"start","previous_run_ended_cleanly":true}\n' +
      '{"time":"2026-10-20T09:07:00.000+02:00","event":"tak\n')
    expect(warning()).toBe('Long break in 2 minutes. 120 minutes since you started.')
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('cannot read break log line 2'))
  })
})

describe('long break window text', () => {
  const noFocusLog = { warning: 'No window data today. Is the focus-log extension running?' }

  it('heads with the time since the last break and counts today\'s breaks across a restart', async () => {
    await writeLog([
      { time: '2026-10-19T17:00:00.000+02:00', event: 'taken', break_type: 'long', seconds_shown: 300 },
      { time: '2026-10-19T17:10:00.000+02:00', event: 'postponed', previous_postpones: 0, break_type: 'long', seconds_shown: 3 },
      { time: '2026-10-20T08:00:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T08:20:00.000+02:00', event: 'natural_break_restarted', idle_seconds: 400 },
      { time: '2026-10-20T08:30:00.000+02:00', event: 'quit', minutes_to_next_break: 25 },
      { time: '2026-10-20T08:40:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T09:00:00.000+02:00', event: 'away_break', away_seconds: 600, cause: 'lock', break_type: 'long' },
      { time: '2026-10-20T09:08:00.000+02:00', event: 'taken', break_type: 'long', seconds_shown: 300 }
    ])
    expect(longBreakWindowText({ logFilePath, focusLogPath }))
      .toEqual(['52 minutes since your last break', 'Today: 3 breaks taken · 0 postponed', noFocusLog])
  })

  it('counts every press of postpone, and says since you started before any break', async () => {
    await writeLog([
      { time: '2026-10-20T09:00:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T09:20:00.000+02:00', event: 'taken', break_type: 'mini', seconds_shown: 20 },
      { time: '2026-10-20T09:30:00.000+02:00', event: 'paused', pause_minutes: 10, break_type: 'long' },
      { time: '2026-10-20T09:40:00.000+02:00', event: 'resumed', paused_minutes: 10 },
      { time: '2026-10-20T09:50:00.000+02:00', event: 'postponed', previous_postpones: 0, break_type: 'long', seconds_shown: 3 },
      { time: '2026-10-20T09:55:00.000+02:00', event: 'postponed', previous_postpones: 1, break_type: 'long', seconds_shown: 4 }
    ])
    expect(longBreakWindowText({ logFilePath, focusLogPath }))
      .toEqual(['60 minutes since you started', 'Today: 0 breaks taken · 2 postponed', noFocusLog])
  })

  it('says a single break taken in the singular', async () => {
    await writeLog([
      { time: '2026-10-20T09:00:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T09:59:00.000+02:00', event: 'taken', break_type: 'long', seconds_shown: 300 }
    ])
    expect(longBreakWindowText({ logFilePath, focusLogPath }))
      .toEqual(['1 minute since your last break', 'Today: 1 break taken · 0 postponed', noFocusLog])
  })
})

describe('long break window usage from the focus log', () => {
  const startedAtEight = [{ time: '2026-10-20T08:00:00.000+02:00', event: 'start', previous_run_ended_cleanly: true }]

  async function writeFocusLog (lines) {
    await writeFile(focusLogPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  }

  function focus (clock, windowId, appId, title) {
    return { time: `2026-10-20T${clock}.000+02:00`, event: 'focus', window_id: windowId, app_id: appId, title }
  }

  function event (clock, name) {
    return { time: `2026-10-20T${clock}.000+02:00`, event: name }
  }

  it('adds active time to the today line and lists where it went, leaving idle, lock and suspend out', async () => {
    await writeLog(startedAtEight)
    await writeFocusLog([
      focus('08:00:00', 1, 'org.gnome.Terminal.desktop', 'bash'),
      event('08:10:00', 'idle_start'),
      event('08:20:00', 'idle_end'),
      event('08:30:00', 'lock'),
      event('08:40:00', 'unlock'),
      event('08:50:00', 'suspend'),
      event('09:00:00', 'resume'),
      focus('09:20:00', 2, 'firefox.desktop', 'News')
    ])
    expect(longBreakWindowText({ logFilePath, focusLogPath })).toEqual([
      '120 minutes since you started',
      'Today: 1h 30m active · 0 breaks taken · 0 postponed',
      { entries: [{ name: 'Terminal', duration: '50m' }, { name: 'firefox', duration: '40m' }] }
    ])
  })

  it('warns in place of the list when the focus log has nothing since the last break ended', async () => {
    await writeLog([
      ...startedAtEight,
      { time: '2026-10-20T09:30:00.000+02:00', event: 'taken', break_type: 'long', seconds_shown: 300 }
    ])
    await writeFocusLog([
      focus('08:00:00', 1, 'org.gnome.Terminal.desktop', 'bash'),
      focus('09:12:00', 2, 'firefox.desktop', 'News')
    ])
    expect(longBreakWindowText({ logFilePath, focusLogPath })).toEqual([
      '30 minutes since your last break',
      'Today: 1 break taken · 0 postponed',
      { warning: 'No window data since 09:12. Is the focus-log extension running?' }
    ])
  })

  it('warns that there is no window data today when the focus log stopped on an earlier day', async () => {
    await writeLog(startedAtEight)
    await writeFocusLog([
      { time: '2026-10-19T17:00:00.000+02:00', event: 'focus', window_id: 1, app_id: 'firefox.desktop', title: 'News' }
    ])
    expect(longBreakWindowText({ logFilePath, focusLogPath })).toEqual([
      '120 minutes since you started',
      'Today: 0 breaks taken · 0 postponed',
      { warning: 'No window data today. Is the focus-log extension running?' }
    ])
  })

  it('splits VS Code time by workspace, read from the title under either app ID', async () => {
    const connectingTitle = 'dev-container+7b22686f737450617468223a222f686f6d652f6d652f64726f6e655f746f6f6c73227d'
    await writeLog(startedAtEight)
    await writeFocusLog([
      focus('08:00:00', 1, 'code.desktop', 'break_timer - main.js - '),
      focus('08:40:00', 2, 'com.microsoft.VSCode.desktop', 'Dev Container: break_timer + Claude - break_timer - spec.md - '),
      focus('09:10:00', 3, 'code.desktop', connectingTitle),
      focus('09:30:00', 4, 'code.desktop', 'SSH: orin1 - autonomy-engine'),
      focus('09:40:00', 5, 'code.desktop', 'Visual Studio Code'),
      focus('09:45:00', 1, 'code.desktop', 'break_timer - main.js - ')
    ])
    expect(longBreakWindowText({ logFilePath, focusLogPath })[2]).toEqual({
      entries: [
        { name: 'VS Code · break_timer', duration: '55m' },
        { name: 'VS Code · Dev Container: break_timer + Claude / break_timer', duration: '30m' },
        { name: 'VS Code · Dev Container (connecting): drone_tools', duration: '20m' },
        { name: 'VS Code · SSH: orin1 / autonomy-engine', duration: '10m' },
        { name: 'VS Code · (unattributed)', duration: '5m' }
      ]
    })
  })

  it('lists a Brave page with 20 minutes today on its own and sums shorter ones as other tabs', async () => {
    await writeLog(startedAtEight)
    await writeFocusLog([
      focus('08:00:00', 1, 'brave-browser.desktop', '(3) Inbox - Brave'),
      { time: '2026-10-20T08:20:00.000+02:00', event: 'title', window_id: 1, app_id: 'brave-browser.desktop', title: 'Perception profiling comparison - Brave' },
      focus('08:39:59', 2, 'org.gnome.Terminal.desktop', 'bash'),
      focus('09:00:00', 1, 'brave-browser.desktop', 'Docs - Brave'),
      event('09:10:00', 'lock')
    ])
    expect(longBreakWindowText({ logFilePath, focusLogPath })[2]).toEqual({
      entries: [
        { name: 'Brave · other tabs', duration: '29m' },
        { name: 'Terminal', duration: '20m' },
        { name: 'Brave · Inbox', duration: '20m' }
      ]
    })
  })

  it('lists the top 5 entries by desktop name, or title without an app ID, and sums the rest as Other', async () => {
    const applicationsFolder = join(logFolder, 'data', 'applications')
    await mkdir(applicationsFolder, { recursive: true })
    await writeFile(join(applicationsFolder, 'firefox.desktop'),
      '[Desktop Entry]\nName=Firefox Web Browser\nExec=firefox\n\n[Desktop Action new-window]\nName=New Window\n')
    await writeLog(startedAtEight)
    await writeFocusLog([
      focus('08:00:00', 1, 'org.gnome.Terminal.desktop', 'bash'),
      focus('08:30:00', 2, 'firefox.desktop', 'News'),
      focus('08:55:00', 3, 'window:26', 'Hollow Knight'),
      focus('09:15:00', 4, 'mpv.desktop', 'film.mkv'),
      focus('09:30:00', 5, 'org.mozilla.Thunderbird.desktop', 'Inbox'),
      focus('09:40:00', 6, 'spotify.desktop', 'Spotify'),
      focus('09:48:00', 7, 'org.gnome.Nautilus.desktop', 'Home')
    ])
    expect(longBreakWindowText({ logFilePath, focusLogPath })[2]).toEqual({
      entries: [
        { name: 'Terminal', duration: '30m' },
        { name: 'Firefox Web Browser', duration: '25m' },
        { name: 'Hollow Knight', duration: '20m' },
        { name: 'mpv', duration: '15m' },
        { name: 'Nautilus', duration: '12m' },
        { name: 'Other', duration: '18m' }
      ]
    })
  })

  it('counts a second idle start at screen blank and lock, and a repeated focus line, only once', async () => {
    await writeLog(startedAtEight)
    await writeFocusLog([
      focus('08:00:00', 1, 'org.gnome.Terminal.desktop', 'bash'),
      event('08:10:00', 'idle_start'),
      event('08:10:05', 'lock'),
      event('08:10:10', 'idle_start'),
      event('08:30:00', 'unlock'),
      event('08:30:01', 'idle_end'),
      focus('08:30:02', 1, 'org.gnome.Terminal.desktop', 'bash'),
      event('09:00:01', 'lock')
    ])
    expect(longBreakWindowText({ logFilePath, focusLogPath })).toEqual([
      '120 minutes since you started',
      'Today: 40m active · 0 breaks taken · 0 postponed',
      { entries: [{ name: 'Terminal', duration: '40m' }] }
    ])
  })

  it('reads only today\'s lines of a large log, counting nothing from before midnight', async () => {
    const earlierDays = ['{"time":"2026-10-18T09:00:00.000+02:00","event":"foc']
    for (let halfMinute = 0; halfMinute < 3000; halfMinute++) {
      const time = new Date(Date.parse('2026-10-18T10:00:00.000+02:00') + halfMinute * 30000).toISOString()
      earlierDays.push(JSON.stringify({ time, event: 'title', window_id: 9, app_id: 'firefox.desktop', title: `Yesterday's page ${halfMinute}` }))
    }
    earlierDays.push(JSON.stringify({ time: '2026-10-19T23:30:00.000+02:00', event: 'focus', window_id: 9, app_id: 'firefox.desktop', title: 'Late night' }))
    const today = [focus('08:00:00', 1, 'org.gnome.Terminal.desktop', 'bash')]
    for (let step = 1; step < 1800; step++) {
      const time = new Date(Date.parse('2026-10-20T08:00:00.000+02:00') + step * 2000).toISOString()
      today.push({ time, event: 'title', window_id: 1, app_id: 'org.gnome.Terminal.desktop', title: 'bash' })
    }
    today.push(event('09:00:00', 'lock'))
    await writeLog(startedAtEight)
    await writeFile(focusLogPath, earlierDays.join('\n') + '\n' + today.map(line => JSON.stringify(line)).join('\n') + '\n')
    expect(longBreakWindowText({ logFilePath, focusLogPath })).toEqual([
      '120 minutes since you started',
      'Today: 1h 0m active · 0 breaks taken · 0 postponed',
      { entries: [{ name: 'Terminal', duration: '1h 0m' }] }
    ])
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('treats a focus log it cannot read as missing, so the break window still opens', async () => {
    await writeLog(startedAtEight)
    await mkdir(focusLogPath)
    expect(longBreakWindowText({ logFilePath, focusLogPath })).toEqual([
      '120 minutes since you started',
      'Today: 0 breaks taken · 0 postponed',
      { warning: 'No window data today. Is the focus-log extension running?' }
    ])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('cannot read focus log'))
  })

  it('keeps counting the window that had focus overnight, from the first line of today', async () => {
    await writeLog(startedAtEight)
    await writeFocusLog([
      { time: '2026-10-19T21:30:00.000+02:00', event: 'focus', window_id: 1, app_id: 'code.desktop', title: 'drone_tools - main.py - ' },
      { time: '2026-10-19T21:40:00.000+02:00', event: 'lock' },
      { time: '2026-10-19T21:49:00.000+02:00', event: 'suspend' },
      event('08:00:00', 'resume'),
      event('08:00:10', 'unlock'),
      event('08:30:10', 'lock')
    ])
    expect(longBreakWindowText({ logFilePath, focusLogPath })).toEqual([
      '120 minutes since you started',
      'Today: 30m active · 0 breaks taken · 0 postponed',
      { entries: [{ name: 'VS Code · drone_tools', duration: '30m' }] }
    ])
  })
})
