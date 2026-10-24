import { vi, expect } from 'vitest'
import EventEmitter from 'events'
import { join } from 'path'
import { tmpdir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import Store from 'electron-store'
import dbus from '@particle/dbus-next'
import BreaksPlanner from '../app/breaksPlanner'
import BreakLog from '../app/utils/breakLog.js'
import GnomeSession from '../app/utils/gnomeSession.js'
import AwayBreaks from '../app/utils/awayBreaks.js'
import defaultSettings from '../app/utils/defaultSettings'
import { sessionBusDeliveringSignals, screenSaverActiveChanged } from './helpers/sessionBusFakes.js'

vi.mock('@particle/dbus-next', async (importOriginal) => {
  const actualDbus = (await importOriginal()).default
  return { default: { ...actualDbus, sessionBus: vi.fn() } }
})

const oneMinute = 60 * 1000
const resetTime = defaultSettings.naturalBreaksInactivityResetTime
const microbreakInterval = defaultSettings.microbreakInterval

describe('AwayBreaks', () => {
  let settingsFolder = null
  let settings = null
  let breakLogPath = null
  let breaksPlanner = null
  let sessionBus = null
  let powerMonitor = null
  let closeBreakPopup = null
  let breakLog = null

  function breakLogLines () {
    if (!existsSync(breakLogPath)) return []
    return readFileSync(breakLogPath, 'utf8').trimEnd().split('\n').map(line => {
      const { time, ...fields } = JSON.parse(line)
      return fields
    })
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    settingsFolder = await mkdtemp(join(tmpdir(), 'stretchly-away-breaks-'))
    breakLogPath = join(settingsFolder, 'breaks.jsonl')
    settings = new Store({ cwd: settingsFolder, name: 'settings', defaults: defaultSettings })
    settings.set('naturalBreaks', false)
    settings.set('monitorDnd', false)
    breaksPlanner = new BreaksPlanner(settings)
    breaksPlanner.nextBreak()
    sessionBus = sessionBusDeliveringSignals()
    dbus.sessionBus.mockReturnValue(sessionBus)
    powerMonitor = new EventEmitter()
    breakLog = new BreakLog(breakLogPath)
    // Stands in for the main process, which tells the break log when a popup closes.
    closeBreakPopup = vi.fn(() => breakLog.noteBreakClosed())
    const awayBreaks = new AwayBreaks({
      settings, breakPlanner: breaksPlanner, breakLog, closeBreakPopup, updateTray: () => {}
    })
    awayBreaks.listen(powerMonitor, new GnomeSession())
  })

  afterEach(async () => {
    breaksPlanner.clear()
    breaksPlanner.naturalBreaksManager.stop()
    vi.useRealTimers()
    await rm(settingsFolder, { recursive: true, force: true })
  })

  it('leaves the schedule running and writes nothing for a lock shorter than the reset time', async () => {
    sessionBus.deliver(screenSaverActiveChanged(true))
    await vi.advanceTimersByTimeAsync(resetTime - oneMinute)
    sessionBus.deliver(screenSaverActiveChanged(false))
    expect(breaksPlanner.isPaused).toBe(false)
    expect(breaksPlanner.timeToNextBreak).toBe(microbreakInterval - (resetTime - oneMinute))
    expect(breakLogLines()).toEqual([])
  })

  it('restarts the schedule and writes away_break at the end of a lock as long as the reset time', async () => {
    sessionBus.deliver(screenSaverActiveChanged(true))
    await vi.advanceTimersByTimeAsync(resetTime)
    sessionBus.deliver(screenSaverActiveChanged(false))
    expect(breaksPlanner.timeToNextBreak).toBe(microbreakInterval)
    expect(breakLogLines()).toEqual([
      { event: 'away_break', away_seconds: resetTime / 1000, cause: 'lock', break_type: 'mini' }
    ])
  })

  it('leaves the schedule running and writes nothing for a suspend shorter than the reset time', async () => {
    powerMonitor.emit('suspend')
    vi.setSystemTime(Date.now() + resetTime - oneMinute)
    powerMonitor.emit('resume')
    expect(breaksPlanner.isPaused).toBe(false)
    expect(breaksPlanner.timeToNextBreak).toBe(microbreakInterval - (resetTime - oneMinute))
    expect(breakLogLines()).toEqual([])
  })

  it('restarts the schedule and writes away_break at the wake from a suspend as long as the reset time', async () => {
    powerMonitor.emit('suspend')
    // Timers stand still during a suspend; only the wall clock moves on.
    vi.setSystemTime(Date.now() + resetTime + 2000)
    powerMonitor.emit('resume')
    expect(breaksPlanner.timeToNextBreak).toBe(microbreakInterval)
    expect(breakLogLines()).toEqual([
      { event: 'away_break', away_seconds: resetTime / 1000 + 2, cause: 'suspend', break_type: 'mini' }
    ])
  })

  it('counts a lock followed by a suspend as one spell that ends at the unlock after the wake', async () => {
    sessionBus.deliver(screenSaverActiveChanged(true))
    powerMonitor.emit('lock-screen')
    await vi.advanceTimersByTimeAsync(oneMinute)
    powerMonitor.emit('suspend')
    vi.setSystemTime(Date.now() + resetTime)
    powerMonitor.emit('resume')
    expect(breakLogLines()).toEqual([])
    await vi.advanceTimersByTimeAsync(oneMinute)
    sessionBus.deliver(screenSaverActiveChanged(false))
    powerMonitor.emit('unlock-screen')
    expect(breaksPlanner.timeToNextBreak).toBe(microbreakInterval)
    expect(breakLogLines()).toEqual([
      { event: 'away_break', away_seconds: resetTime / 1000 + 120, cause: 'lock', break_type: 'mini' }
    ])
  })

  it('counts a suspend followed by a lock as one spell that ends at the wake after the unlock', async () => {
    powerMonitor.emit('suspend')
    sessionBus.deliver(screenSaverActiveChanged(true))
    sessionBus.deliver(screenSaverActiveChanged(false))
    expect(breakLogLines()).toEqual([])
    vi.setSystemTime(Date.now() + resetTime)
    powerMonitor.emit('resume')
    expect(breaksPlanner.timeToNextBreak).toBe(microbreakInterval)
    expect(breakLogLines()).toEqual([
      { event: 'away_break', away_seconds: resetTime / 1000, cause: 'suspend', break_type: 'mini' }
    ])
  })

  it('closes a popup that showed during a long lock, writing its break type and seconds shown', async () => {
    sessionBus.deliver(screenSaverActiveChanged(true))
    await vi.advanceTimersByTimeAsync(oneMinute)
    // What the main process does when a mini break popup comes up.
    breaksPlanner.scheduler.cancel()
    breaksPlanner.emit('microbreakStarted', true)
    breakLog.noteBreakShown({ breakType: 'mini' })
    vi.setSystemTime(Date.now() + resetTime)
    sessionBus.deliver(screenSaverActiveChanged(false))
    expect(closeBreakPopup).toHaveBeenCalledTimes(1)
    expect(breaksPlanner.timeToNextBreak).toBe(microbreakInterval)
    expect(breakLogLines()).toEqual([
      { event: 'away_break', away_seconds: resetTime / 1000 + 60, cause: 'lock', break_type: 'mini', seconds_shown: resetTime / 1000 }
    ])
  })

  describe('with natural breaks on', () => {
    const checkInterval = defaultSettings.naturalBreaksCheckInterval
    let lastInputAt = null
    let naturalBreakRestarts = 0

    beforeEach(() => {
      lastInputAt = Date.now()
      naturalBreakRestarts = 0
      breaksPlanner.on('naturalBreakRestarted', () => { naturalBreakRestarts += 1 })
      breaksPlanner.naturalBreaksManager.readIdleTime = async () => Date.now() - lastInputAt
      settings.set('naturalBreaks', true)
      breaksPlanner.naturalBreaks(true)
    })

    it('leaves the restart to a natural break that cleared the schedule during a lock and ends after the unlock', async () => {
      sessionBus.deliver(screenSaverActiveChanged(true))
      await vi.advanceTimersByTimeAsync(resetTime + oneMinute)
      sessionBus.deliver(screenSaverActiveChanged(false))
      expect(breaksPlanner.timeToNextBreak).toBe(null)
      lastInputAt = Date.now()
      await vi.advanceTimersByTimeAsync(checkInterval)
      expect(naturalBreakRestarts).toBe(1)
      expect(breaksPlanner.timeToNextBreak).toBe(microbreakInterval)
      expect(breakLogLines()).toEqual([])
    })

    it('restarts once when the natural break ends before the unlock arrives', async () => {
      sessionBus.deliver(screenSaverActiveChanged(true))
      await vi.advanceTimersByTimeAsync(resetTime + oneMinute)
      lastInputAt = Date.now()
      await vi.advanceTimersByTimeAsync(checkInterval)
      expect(naturalBreakRestarts).toBe(1)
      await vi.advanceTimersByTimeAsync(checkInterval)
      sessionBus.deliver(screenSaverActiveChanged(false))
      expect(breaksPlanner.timeToNextBreak).toBe(microbreakInterval - checkInterval)
      expect(breakLogLines()).toEqual([])
    })
  })

  it('leaves the schedule running and writes nothing for a long lock with pauseForSuspendOrLock off', async () => {
    settings.set('pauseForSuspendOrLock', false)
    sessionBus.deliver(screenSaverActiveChanged(true))
    await vi.advanceTimersByTimeAsync(resetTime + oneMinute)
    sessionBus.deliver(screenSaverActiveChanged(false))
    expect(breaksPlanner.timeToNextBreak).toBe(microbreakInterval - resetTime - oneMinute)
    expect(breakLogLines()).toEqual([])
  })

  it('ends the spell when the GNOME watch comes back after the unlock was missed', async () => {
    sessionBus.deliver(screenSaverActiveChanged(true))
    await vi.advanceTimersByTimeAsync(resetTime)
    dbus.sessionBus.mockReturnValue(sessionBusDeliveringSignals({ screenSaverActive: false }))
    sessionBus.close()
    await vi.advanceTimersByTimeAsync(oneMinute)
    // The watch's retry delay belongs to the GNOME session, so only the line's kind is pinned.
    expect(breakLogLines()).toMatchObject([{ event: 'away_break', cause: 'lock' }])
  })

  it('brings a break due while timers were stalled forward on an unlock that ends no spell', async () => {
    const breakNotifications = []
    breaksPlanner.on('startMicrobreakNotification', () => breakNotifications.push('mini'))
    breaksPlanner.on('startBreakNotification', () => breakNotifications.push('long'))
    vi.setSystemTime(Date.now() + microbreakInterval)
    powerMonitor.emit('unlock-screen')
    await vi.advanceTimersByTimeAsync(1)
    expect(breakNotifications).toHaveLength(1)
  })
})
