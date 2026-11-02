import { vi, expect } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
      .toEqual({ headline: '52 minutes since your last break', todayLine: 'Today: 3 breaks taken · 0 postponed', usage: noFocusLog })
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
      .toEqual({ headline: '60 minutes since you started', todayLine: 'Today: 0 breaks taken · 2 postponed', usage: noFocusLog })
  })

  it('says a single break taken in the singular', async () => {
    await writeLog([
      { time: '2026-10-20T09:00:00.000+02:00', event: 'start', previous_run_ended_cleanly: true },
      { time: '2026-10-20T09:59:00.000+02:00', event: 'taken', break_type: 'long', seconds_shown: 300 }
    ])
    expect(longBreakWindowText({ logFilePath, focusLogPath }))
      .toEqual({ headline: '1 minute since your last break', todayLine: 'Today: 1 break taken · 0 postponed', usage: noFocusLog })
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
    expect(longBreakWindowText({ logFilePath, focusLogPath })).toEqual({
      headline: '120 minutes since you started',
      todayLine: 'Today: 1h 30m active · 0 breaks taken · 0 postponed',
      usage: { entries: [{ name: 'Terminal', duration: '50m' }, { name: 'firefox', duration: '40m' }] }
    })
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
    expect(longBreakWindowText({ logFilePath, focusLogPath })).toEqual({
      headline: '30 minutes since your last break',
      todayLine: 'Today: 1 break taken · 0 postponed',
      usage: { warning: 'No window data since 09:12. Is the focus-log extension running?' }
    })
  })
})
