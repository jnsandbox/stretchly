import { vi, expect } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import Store from 'electron-store'
import BreaksPlanner from '../app/breaksPlanner'
import defaultSettings from '../app/utils/defaultSettings'

describe('breaksPlanner', () => {
  let settingsFolder = null
  let breaksPlanner = null

  beforeEach(async () => {
    vi.useFakeTimers()
    settingsFolder = await mkdtemp(join(tmpdir(), 'stretchly-breaks-planner-'))
    const settings = new Store({ cwd: settingsFolder, name: 'settings', defaults: defaultSettings })
    settings.set('naturalBreaks', false)
    settings.set('monitorDnd', false)
    breaksPlanner = new BreaksPlanner(settings)
    breaksPlanner.nextBreak()
  })

  afterEach(async () => {
    breaksPlanner.clear()
    vi.useRealTimers()
    await rm(settingsFolder, { recursive: true, force: true })
  })

  it('counts the postpones of the break due next', () => {
    breaksPlanner.postponeCurrentBreak()
    breaksPlanner.postponeCurrentBreak()
    expect(breaksPlanner.postponesOfCurrentBreak).toBe(2)
  })

  it('starts the postpone count again for the next planned break', () => {
    breaksPlanner.postponeCurrentBreak()
    breaksPlanner.nextBreak()
    expect(breaksPlanner.postponesOfCurrentBreak).toBe(0)
  })

  it('starts the postpone count again when skipping ahead to a Mini break', () => {
    breaksPlanner.postponeCurrentBreak()
    breaksPlanner.skipToMicrobreak()
    expect(breaksPlanner.postponesOfCurrentBreak).toBe(0)
  })

  it('starts the postpone count again when skipping ahead to a Long break', () => {
    breaksPlanner.postponeCurrentBreak()
    breaksPlanner.skipToBreak()
    expect(breaksPlanner.postponesOfCurrentBreak).toBe(0)
  })

  it('plans a Mini break first', () => {
    expect(breaksPlanner.plannedBreakType).toBe('mini')
  })

  it('reports a Long break once skipped ahead to one', () => {
    breaksPlanner.skipToBreak()
    expect(breaksPlanner.plannedBreakType).toBe('long')
  })

  it('reports the break showing while its popup is up', () => {
    breaksPlanner.skipToBreak()
    breaksPlanner.emit('breakStarted', false)
    expect(breaksPlanner.plannedBreakType).toBe('long')
  })

  it('reports no break while paused', () => {
    breaksPlanner.pause(1800000)
    expect(breaksPlanner.plannedBreakType).toBe(null)
  })

  // Each start records whether a skip ahead brought it on, as the break log reports it.
  function recordBreakStarts () {
    const breakStarts = []
    breaksPlanner.on('startMicrobreak', (start) => breakStarts.push(['mini', start?.startedEarly === true]))
    breaksPlanner.on('startBreak', (start) => breakStarts.push(['long', start?.startedEarly === true]))
    return breakStarts
  }

  it('starts a break skipped ahead to at once as started early', () => {
    const breakStarts = recordBreakStarts()
    breaksPlanner.skipToBreak()
    vi.advanceTimersByTime(100)
    expect(breakStarts).toEqual([['long', true]])
  })

  it('starts a break skipped ahead to with a wait as started early when the wait ends', () => {
    const breakStarts = recordBreakStarts()
    breaksPlanner.skipToMicrobreak(600000)
    vi.advanceTimersByTime(599999)
    expect(breakStarts).toEqual([])
    vi.advanceTimersByTime(1)
    expect(breakStarts).toEqual([['mini', true]])
  })

  it('starts a scheduled break as not started early', () => {
    const breakStarts = recordBreakStarts()
    breaksPlanner.settings.set('microbreakNotification', false)
    breaksPlanner.nextBreak()
    vi.advanceTimersByTime(breaksPlanner.settings.get('microbreakInterval'))
    expect(breakStarts).toEqual([['mini', false]])
  })

  it('never starts a break skipped ahead to with a wait when a pause comes first', () => {
    const breakStarts = recordBreakStarts()
    breaksPlanner.settings.set('microbreakNotification', false)
    breaksPlanner.skipToMicrobreak(600000)
    breaksPlanner.pause(300000)
    breaksPlanner.resume()
    vi.advanceTimersByTime(breaksPlanner.settings.get('microbreakInterval'))
    expect(breakStarts).toEqual([['mini', false]])
  })

  it('never starts a break skipped ahead to with a wait when a natural break comes first', () => {
    const breakStarts = recordBreakStarts()
    breaksPlanner.settings.set('microbreakNotification', false)
    breaksPlanner.skipToBreak(600000)
    breaksPlanner.naturalBreaksManager.emit('clearBreakScheduler')
    breaksPlanner.naturalBreaksManager.emit('naturalBreakFinished', 300000)
    vi.advanceTimersByTime(breaksPlanner.settings.get('microbreakInterval'))
    expect(breakStarts).toEqual([['mini', false]])
  })

  it('reports the break it cleared when idle clears the schedule, once per idle spell', () => {
    const clearedBreakTypes = []
    breaksPlanner.on('naturalBreakCleared', (breakType) => clearedBreakTypes.push(breakType))
    // The idle monitor repeats this on every check while the idle spell lasts.
    breaksPlanner.naturalBreaksManager.emit('clearBreakScheduler')
    breaksPlanner.naturalBreaksManager.emit('clearBreakScheduler')
    expect(clearedBreakTypes).toEqual(['mini'])
  })

  it('reports the idle time when it restarts the schedule after idle', () => {
    const restartIdleTimes = []
    breaksPlanner.on('naturalBreakRestarted', (idleMilliseconds) => restartIdleTimes.push(idleMilliseconds))
    breaksPlanner.naturalBreaksManager.emit('clearBreakScheduler')
    breaksPlanner.naturalBreaksManager.emit('naturalBreakFinished', 412000)
    expect(restartIdleTimes).toEqual([412000])
  })

  it('reports the break it cleared when Do Not Disturb clears the schedule', () => {
    const clearedBreakTypes = []
    breaksPlanner.on('doNotDisturbCleared', (breakType) => clearedBreakTypes.push(breakType))
    breaksPlanner.dndManager.isOnDnd = true
    breaksPlanner.dndManager.emit('dndStarted')
    expect(clearedBreakTypes).toEqual(['mini'])
  })

  it('reports nothing when Do Not Disturb switches on while paused', () => {
    const doNotDisturbEvents = []
    breaksPlanner.on('doNotDisturbCleared', () => doNotDisturbEvents.push('cleared'))
    breaksPlanner.on('doNotDisturbRestarted', () => doNotDisturbEvents.push('restarted'))
    breaksPlanner.pause(1800000)
    breaksPlanner.dndManager.isOnDnd = true
    breaksPlanner.dndManager.emit('dndStarted')
    expect(doNotDisturbEvents).toEqual([])
  })

  it('reports the restart when Do Not Disturb switching off restarts the schedule', () => {
    let restartCount = 0
    breaksPlanner.on('doNotDisturbRestarted', () => restartCount++)
    breaksPlanner.dndManager.isOnDnd = true
    breaksPlanner.dndManager.emit('dndStarted')
    breaksPlanner.dndManager.isOnDnd = false
    breaksPlanner.dndManager.emit('dndFinished')
    expect(restartCount).toBe(1)
    expect(breaksPlanner.plannedBreakType).toBe('mini')
  })

  // stretchly skips resuming while it believes Do Not Disturb is on, which would leave
  // the pause unended in the break log.
  it('ends a timed pause with Do Not Disturb marked off, though it was on before the pause', async () => {
    breaksPlanner.settings.set('monitorDnd', true)
    vi.spyOn(breaksPlanner.dndManager, '_doNotDisturb').mockResolvedValue(true)
    breaksPlanner.doNotDisturb(true)
    await vi.advanceTimersByTimeAsync(breaksPlanner.settings.get('monitorDndCheckInterval'))
    expect(breaksPlanner.dndManager.isOnDnd).toBe(true)
    const doNotDisturbStatesAtResume = []
    breaksPlanner.on('resumeBreaks', () => doNotDisturbStatesAtResume.push(breaksPlanner.dndManager.isOnDnd))
    breaksPlanner.pause(1800000)
    await vi.advanceTimersByTimeAsync(1800000)
    expect(doNotDisturbStatesAtResume).toEqual([false])
    breaksPlanner.dndManager.stop()
  })
})
