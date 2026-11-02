import { vi, expect } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import log from 'electron-log/main.js'
import { longBreakWarning } from '../app/utils/timeSinceLastBreak'

vi.mock('electron-log/main.js', () => ({ default: { warn: vi.fn() } }))

process.env.TZ = 'Europe/Amsterdam'

const twoMinutes = 120000

describe('long break warning', () => {
  let logFolder = null
  let logFilePath = null

  // secondsText stands in for stretchly's own translated lead-time text.
  function warning (leadMilliseconds = twoMinutes) {
    return longBreakWarning({
      leadMilliseconds,
      secondsText: `Long break in ${leadMilliseconds / 1000} seconds`,
      logFilePath
    })
  }

  async function writeLog (lines) {
    await writeFile(logFilePath, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  }

  beforeEach(async () => {
    logFolder = await mkdtemp(join(tmpdir(), 'stretchly-since-last-break-'))
    logFilePath = join(logFolder, 'breaks.jsonl')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T10:00:30.000+02:00'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.clearAllMocks()
    await rm(logFolder, { recursive: true, force: true })
  })

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
