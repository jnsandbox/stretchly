import { vi, expect } from 'vitest'
import EventEmitter from 'events'
import { join } from 'path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import Store from 'electron-store'
import dbus from '@particle/dbus-next'
import BreaksPlanner from '../app/breaksPlanner'
import GnomeSession from '../app/utils/gnomeSession.js'
import SuspendOrLockPause from '../app/utils/suspendOrLockPause.js'
import defaultSettings from '../app/utils/defaultSettings'
import { sessionBusDeliveringSignals, screenSaverActiveChanged } from './helpers/sessionBusFakes.js'

vi.mock('@particle/dbus-next', async (importOriginal) => {
  const actualDbus = (await importOriginal()).default
  return { default: { ...actualDbus, sessionBus: vi.fn() } }
})

const indefinitePauseMilliseconds = 1
const shouldWriteBreakLogLine = false
const shouldNotify = false

describe('SuspendOrLockPause', () => {
  let settingsFolder = null
  let breaksPlanner = null
  let sessionBus = null
  let powerMonitor = null
  let pauseBreaks = null
  let resumeBreaks = null

  beforeEach(async () => {
    vi.useFakeTimers()
    settingsFolder = await mkdtemp(join(tmpdir(), 'stretchly-suspend-or-lock-pause-'))
    const settings = new Store({ cwd: settingsFolder, name: 'settings', defaults: defaultSettings })
    settings.set('naturalBreaks', false)
    settings.set('monitorDnd', false)
    breaksPlanner = new BreaksPlanner(settings)
    breaksPlanner.nextBreak()
    sessionBus = sessionBusDeliveringSignals()
    dbus.sessionBus.mockReturnValue(sessionBus)
    powerMonitor = new EventEmitter()
    pauseBreaks = vi.fn((milliseconds) => breaksPlanner.pause(milliseconds))
    resumeBreaks = vi.fn(() => breaksPlanner.resume())
    const suspendOrLockPause = new SuspendOrLockPause({
      settings, breakPlanner: breaksPlanner, pauseBreaks, resumeBreaks, updateTray: () => {}
    })
    suspendOrLockPause.listen(powerMonitor, new GnomeSession())
  })

  afterEach(async () => {
    breaksPlanner.clear()
    vi.useRealTimers()
    await rm(settingsFolder, { recursive: true, force: true })
  })

  it('pauses breaks without a break-log line on GNOME\'s screen lock, and resumes them on unlock', () => {
    sessionBus.deliver(screenSaverActiveChanged(true))
    expect(pauseBreaks.mock.calls).toEqual([[indefinitePauseMilliseconds, shouldWriteBreakLogLine]])
    expect(breaksPlanner.isPaused).toBe(true)

    sessionBus.deliver(screenSaverActiveChanged(false))
    expect(resumeBreaks.mock.calls).toEqual([[shouldNotify]])
    expect(breaksPlanner.isPaused).toBe(false)
  })

  it('pauses and resumes once for a lock that both GNOME and Electron report', () => {
    powerMonitor.emit('lock-screen')
    sessionBus.deliver(screenSaverActiveChanged(true))
    sessionBus.deliver(screenSaverActiveChanged(false))
    powerMonitor.emit('unlock-screen')
    expect(pauseBreaks).toHaveBeenCalledTimes(1)
    expect(resumeBreaks).toHaveBeenCalledTimes(1)
    expect(breaksPlanner.isPaused).toBe(false)
  })

  it('pauses breaks without a break-log line for a suspend, and resumes them on resume', () => {
    powerMonitor.emit('suspend')
    expect(pauseBreaks.mock.calls).toEqual([[indefinitePauseMilliseconds, shouldWriteBreakLogLine]])
    powerMonitor.emit('resume')
    expect(resumeBreaks.mock.calls).toEqual([[shouldNotify]])
    expect(breaksPlanner.isPaused).toBe(false)
  })

  it('resumes breaks when the watch comes back after GNOME\'s unlock was missed', async () => {
    sessionBus.deliver(screenSaverActiveChanged(true))
    dbus.sessionBus.mockReturnValue(sessionBusDeliveringSignals({ screenSaverActive: false }))
    sessionBus.close()
    await vi.advanceTimersByTimeAsync(60000)
    expect(resumeBreaks.mock.calls).toEqual([[shouldNotify]])
    expect(breaksPlanner.isPaused).toBe(false)
  })

  it('brings a break due while timers were stalled forward on an unlock that ends no pause', async () => {
    const breakNotifications = []
    breaksPlanner.on('startMicrobreakNotification', () => breakNotifications.push('mini'))
    breaksPlanner.on('startBreakNotification', () => breakNotifications.push('long'))
    vi.setSystemTime(Date.now() + defaultSettings.microbreakInterval)
    powerMonitor.emit('unlock-screen')
    await vi.advanceTimersByTimeAsync(1)
    expect(breakNotifications).toHaveLength(1)
    expect(pauseBreaks).not.toHaveBeenCalled()
    expect(resumeBreaks).not.toHaveBeenCalled()
  })
})
