import { vi, expect } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'node:os'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import BreakLog from '../app/utils/breakLog'

process.env.TZ = 'Europe/Amsterdam'

describe('breakLog', () => {
  let logFolder = null
  let logFilePath = null

  async function readLogLines () {
    const contents = await readFile(logFilePath, 'utf8')
    return contents.split('\n').filter(line => line !== '').map(line => JSON.parse(line))
  }

  // Break-event tests leave the time out; its format has tests of its own.
  async function readLogLinesWithoutTime () {
    return (await readLogLines()).map(({ time, ...fields }) => fields)
  }

  beforeEach(async () => {
    logFolder = await mkdtemp(join(tmpdir(), 'stretchly-break-log-'))
    logFilePath = join(logFolder, 'breaks.jsonl')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T07:15:02.042Z'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(logFolder, { recursive: true, force: true })
  })

  it('writes a clean start when there is no log yet', async () => {
    new BreakLog(logFilePath).recordStart()
    expect(await readLogLines()).toEqual([
      { time: '2026-10-20T09:15:02.042+02:00', event: 'start', previous_run_ended_cleanly: true }
    ])
  })

  it('writes the minutes left to the next break at quit', async () => {
    new BreakLog(logFilePath).recordQuit({ millisecondsToNextBreak: 754000 })
    expect(await readLogLines()).toEqual([
      { time: '2026-10-20T09:15:02.042+02:00', event: 'quit', minutes_to_next_break: 12.6 }
    ])
  })

  it('flags a start whose previous run ended without a quit', async () => {
    await writeFile(logFilePath, '{"time":"2026-10-20T08:00:00.000+02:00","event":"start","previous_run_ended_cleanly":true}\n')
    new BreakLog(logFilePath).recordStart()
    const lines = await readLogLines()
    expect(lines.at(-1)).toEqual(
      { time: '2026-10-20T09:15:02.042+02:00', event: 'start', previous_run_ended_cleanly: false }
    )
  })

  it('writes no minutes to the next break when none is scheduled', async () => {
    new BreakLog(logFilePath).recordQuit({ millisecondsToNextBreak: null })
    expect((await readLogLines())[0].minutes_to_next_break).toBe(null)
  })

  it('writes a clean start after a run that quit', async () => {
    new BreakLog(logFilePath).recordStart()
    new BreakLog(logFilePath).recordQuit({ millisecondsToNextBreak: 60000 })
    new BreakLog(logFilePath).recordStart()
    expect((await readLogLines()).map(line => [line.event, line.previous_run_ended_cleanly])).toEqual([
      ['start', true],
      ['quit', undefined],
      ['start', true]
    ])
  })

  it('writes a clean start when the log is empty', async () => {
    await writeFile(logFilePath, '')
    new BreakLog(logFilePath).recordStart()
    expect((await readLogLines())[0].previous_run_ended_cleanly).toBe(true)
  })

  it('flags a start after a last line cut off mid-write', async () => {
    await writeFile(logFilePath, '{"time":"2026-10-20T08:00:00.000+02:00","event":"qu')
    new BreakLog(logFilePath).recordStart()
    const contents = await readFile(logFilePath, 'utf8')
    expect(JSON.parse(contents.trimEnd().split('\n').at(-1)).previous_run_ended_cleanly).toBe(false)
  })

  it('writes a break that ran its full length as taken, with the seconds it was shown', async () => {
    const breakLog = new BreakLog(logFilePath)
    breakLog.noteBreakShown({ breakType: 'long' })
    vi.advanceTimersByTime(300000)
    breakLog.recordTaken()
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'taken', break_type: 'long', seconds_shown: 300 }
    ])
  })

  it('writes a break ended before its full length as finished early, to a tenth of a second', async () => {
    const breakLog = new BreakLog(logFilePath)
    breakLog.noteBreakShown({ breakType: 'mini' })
    vi.advanceTimersByTime(4260)
    breakLog.recordFinishedEarly()
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'finished_early', break_type: 'mini', seconds_shown: 4.3 }
    ])
  })

  it('writes each postpone of one break with its own seconds shown and the postpones before it', async () => {
    const breakLog = new BreakLog(logFilePath)
    breakLog.noteBreakShown({ breakType: 'long' })
    vi.advanceTimersByTime(3000)
    breakLog.recordPostponed({ previousPostpones: 0 })
    vi.advanceTimersByTime(300000)
    breakLog.noteBreakShown({ breakType: 'long' })
    vi.advanceTimersByTime(1500)
    breakLog.recordPostponed({ previousPostpones: 1 })
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'postponed', break_type: 'long', seconds_shown: 3, previous_postpones: 0 },
      { event: 'postponed', break_type: 'long', seconds_shown: 1.5, previous_postpones: 1 }
    ])
  })

  it('writes nothing at a skip ahead with no popup showing', async () => {
    const breakLog = new BreakLog(logFilePath)
    breakLog.recordSkippedAhead()
    breakLog.recordStart()
    expect((await readLogLinesWithoutTime()).map(line => line.event)).toEqual(['start'])
  })

  it('writes a skip ahead from a showing popup as that popup skipped ahead, at once', async () => {
    const breakLog = new BreakLog(logFilePath)
    breakLog.noteBreakShown({ breakType: 'mini' })
    vi.advanceTimersByTime(8000)
    breakLog.recordSkippedAhead()
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'skipped_ahead', break_type: 'mini', seconds_shown: 8 }
    ])
  })

  it('writes a break a skip ahead brought on as started early when it shows', async () => {
    new BreakLog(logFilePath).noteBreakShown({ breakType: 'long', startedEarly: true })
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'started_early', break_type: 'long' }
    ])
  })

  it('writes a quit during a break with the break type and the seconds it was shown', async () => {
    const breakLog = new BreakLog(logFilePath)
    breakLog.noteBreakShown({ breakType: 'long' })
    vi.advanceTimersByTime(12000)
    breakLog.recordQuit({ millisecondsToNextBreak: null })
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'quit', minutes_to_next_break: null, break_type: 'long', seconds_shown: 12 }
    ])
  })

  it('writes a quit after a break popup closed without break fields', async () => {
    const breakLog = new BreakLog(logFilePath)
    breakLog.noteBreakShown({ breakType: 'mini' })
    breakLog.noteBreakClosed()
    breakLog.recordQuit({ millisecondsToNextBreak: 60000 })
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'quit', minutes_to_next_break: 1 }
    ])
  })

  it('writes a break event with no popup on record with null break fields', async () => {
    new BreakLog(logFilePath).recordTaken()
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'taken', break_type: null, seconds_shown: null }
    ])
  })

  it('writes a timed pause with the scheduled break type and its length in minutes', async () => {
    new BreakLog(logFilePath).recordPaused({ scheduledBreakType: 'mini', pauseMilliseconds: 1800000 })
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'paused', break_type: 'mini', pause_minutes: 30 }
    ])
  })

  it('writes no pause length for an indefinite pause, which stretchly passes as 1 ms', async () => {
    new BreakLog(logFilePath).recordPaused({ scheduledBreakType: 'long', pauseMilliseconds: 1 })
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'paused', break_type: 'long', pause_minutes: null }
    ])
  })

  it('writes a pause during a break with the shown break type and the seconds it was shown', async () => {
    const breakLog = new BreakLog(logFilePath)
    breakLog.noteBreakShown({ breakType: 'long' })
    vi.advanceTimersByTime(7000)
    breakLog.recordPaused({ scheduledBreakType: 'long', pauseMilliseconds: 3600000 })
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'paused', break_type: 'long', seconds_shown: 7, pause_minutes: 60 }
    ])
  })

  it('writes how long a pause lasted when it ends', async () => {
    const breakLog = new BreakLog(logFilePath)
    breakLog.recordPaused({ scheduledBreakType: 'mini', pauseMilliseconds: 3600000 })
    vi.advanceTimersByTime(2730000)
    breakLog.recordResumed()
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'paused', break_type: 'mini', pause_minutes: 60 },
      { event: 'resumed', paused_minutes: 45.5 }
    ])
  })

  it('writes nothing when breaks resume with no logged pause to end', async () => {
    const breakLog = new BreakLog(logFilePath)
    breakLog.recordResumed()
    breakLog.recordStart()
    expect((await readLogLinesWithoutTime()).map(line => line.event)).toEqual(['start'])
  })

  it('measures a pause from when breaks stopped, across a second pause while paused', async () => {
    const breakLog = new BreakLog(logFilePath)
    breakLog.recordPaused({ scheduledBreakType: 'mini', pauseMilliseconds: 1800000 })
    vi.advanceTimersByTime(600000)
    breakLog.recordPaused({ scheduledBreakType: null, pauseMilliseconds: 3600000 })
    vi.advanceTimersByTime(600000)
    breakLog.recordResumed()
    expect((await readLogLinesWithoutTime()).at(-1)).toEqual({ event: 'resumed', paused_minutes: 20 })
  })

  it('writes a natural break clearing the schedule with the break it cleared', async () => {
    new BreakLog(logFilePath).recordNaturalBreakCleared({ scheduledBreakType: 'long' })
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'natural_break_cleared', break_type: 'long' }
    ])
  })

  it('writes the idle seconds when a natural break restarts the schedule', async () => {
    new BreakLog(logFilePath).recordNaturalBreakRestarted({ idleMilliseconds: 412000 })
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'natural_break_restarted', idle_seconds: 412 }
    ])
  })

  it('writes Do Not Disturb clearing the schedule with the break it cleared', async () => {
    new BreakLog(logFilePath).recordDoNotDisturbCleared({ scheduledBreakType: 'long' })
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'do_not_disturb_cleared', break_type: 'long' }
    ])
  })

  it('writes Do Not Disturb switching off restarting the schedule', async () => {
    new BreakLog(logFilePath).recordDoNotDisturbRestarted()
    expect(await readLogLinesWithoutTime()).toEqual([
      { event: 'do_not_disturb_restarted' }
    ])
  })

  it('stamps the UTC offset in force, which changes with daylight saving time', async () => {
    vi.setSystemTime(new Date('2026-01-20T07:15:02.042Z'))
    new BreakLog(logFilePath).recordStart()
    expect((await readLogLines())[0].time).toBe('2026-01-20T08:15:02.042+01:00')
  })
})
