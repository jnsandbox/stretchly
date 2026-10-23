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

vi.mock('@particle/dbus-next', async (importOriginal) => {
  const actualDbus = (await importOriginal()).default
  return { default: { ...actualDbus, sessionBus: vi.fn() } }
})

// main.js's pauseBreaks takes 1 for an indefinite pause, and false to write no break-log line.
const indefinitePause = 1
const withoutBreakLogLine = false
const withoutNotification = false

function sessionBusDeliveringSignals () {
  const messageListeners = []
  return {
    on: vi.fn((eventName, listener) => { if (eventName === 'message') messageListeners.push(listener) }),
    call: vi.fn(async () => {}),
    deliver: (message) => messageListeners.forEach(listener => listener(message))
  }
}

function screenSaverActiveChanged (isActive) {
  return new dbus.Message({
    type: dbus.MessageType.SIGNAL,
    path: '/org/gnome/ScreenSaver',
    interface: 'org.gnome.ScreenSaver',
    member: 'ActiveChanged',
    signature: 'b',
    body: [isActive]
  })
}

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
    expect(pauseBreaks.mock.calls).toEqual([[indefinitePause, withoutBreakLogLine]])
    expect(breaksPlanner.isPaused).toBe(true)

    sessionBus.deliver(screenSaverActiveChanged(false))
    expect(resumeBreaks.mock.calls).toEqual([[withoutNotification]])
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
    expect(pauseBreaks.mock.calls).toEqual([[indefinitePause, withoutBreakLogLine]])
    powerMonitor.emit('resume')
    expect(resumeBreaks.mock.calls).toEqual([[withoutNotification]])
    expect(breaksPlanner.isPaused).toBe(false)
  })
})
