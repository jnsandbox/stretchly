import { vi, describe, it, beforeEach, afterEach } from 'vitest'
import 'chai/register-should'
import dbus from '@particle/dbus-next'
import GnomeSession from '../app/utils/gnomeSession.js'
import { sessionBusDeliveringSignals, screenSaverActiveChanged } from './helpers/sessionBusFakes.js'

vi.mock('@particle/dbus-next', async (importOriginal) => {
  const actualDbus = (await importOriginal()).default
  return { default: { ...actualDbus, sessionBus: vi.fn() } }
})

function sessionBusWithStalledLookup () {
  return { on: vi.fn(), getProxyObject: vi.fn(() => new Promise(() => {})) }
}

function sessionBusAnsweringGetIdletime (getIdletime) {
  return {
    on: vi.fn(),
    getProxyObject: vi.fn(async (serviceName, objectPath) => ({
      getInterface: (interfaceName) => {
        if (serviceName === 'org.gnome.Mutter.IdleMonitor' &&
          objectPath === '/org/gnome/Mutter/IdleMonitor/Core' &&
          interfaceName === 'org.gnome.Mutter.IdleMonitor') {
          return { GetIdletime: getIdletime }
        }
        throw new Error(`unexpected ${serviceName} ${objectPath} ${interfaceName}`)
      }
    }))
  }
}

describe('GnomeSession', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.useRealTimers() })

  it('reads idle milliseconds from GNOME\'s idle monitor', async () => {
    // dbus-next hands a uint64 reply over as a BigInt
    dbus.sessionBus.mockReturnValue(sessionBusAnsweringGetIdletime(async () => 412345n))
    const idleMilliseconds = await new GnomeSession().idleMilliseconds()
    idleMilliseconds.should.equal(412345)
  })

  it('answers null when the idle monitor call fails', async () => {
    dbus.sessionBus.mockReturnValue(sessionBusAnsweringGetIdletime(async () => {
      throw new Error('org.freedesktop.DBus.Error.ServiceUnknown')
    }))
    const idleMilliseconds = await new GnomeSession().idleMilliseconds()
    ;(idleMilliseconds === null).should.equal(true)
  })

  it('answers null when there is no session bus', async () => {
    dbus.sessionBus.mockImplementation(() => { throw new Error('Could not get session bus address') })
    const idleMilliseconds = await new GnomeSession().idleMilliseconds()
    ;(idleMilliseconds === null).should.equal(true)
  })

  it('answers null when the idle monitor does not reply', async () => {
    vi.useFakeTimers()
    dbus.sessionBus.mockReturnValue(sessionBusAnsweringGetIdletime(() => new Promise(() => {})))
    const idleMillisecondsPromise = new GnomeSession().idleMilliseconds()
    await vi.advanceTimersByTimeAsync(5000)
    ;((await idleMillisecondsPromise) === null).should.equal(true)
  })

  it('answers null when looking up the idle monitor does not complete', async () => {
    vi.useFakeTimers()
    dbus.sessionBus.mockReturnValue(sessionBusWithStalledLookup())
    const idleMillisecondsPromise = new GnomeSession().idleMilliseconds()
    await vi.advanceTimersByTimeAsync(5000)
    ;((await idleMillisecondsPromise) === null).should.equal(true)
  })

  describe('watching the screen lock', () => {
    it('reports GNOME\'s screen lock and unlock', async () => {
      const sessionBus = sessionBusDeliveringSignals()
      dbus.sessionBus.mockReturnValue(sessionBus)
      const reportedLockStates = []
      await new GnomeSession().watchScreenLock(isLocked => reportedLockStates.push(isLocked))
      sessionBus.deliver(screenSaverActiveChanged(true))
      sessionBus.deliver(screenSaverActiveChanged(false))
      reportedLockStates.should.deep.equal([true, false])
    })

    it('keeps reporting the screen lock after the session bus closes', async () => {
      vi.useFakeTimers()
      const firstSessionBus = sessionBusDeliveringSignals()
      const reconnectedSessionBus = sessionBusDeliveringSignals()
      dbus.sessionBus.mockReturnValueOnce(firstSessionBus).mockReturnValueOnce(reconnectedSessionBus)
      const reportedLockStates = []
      await new GnomeSession().watchScreenLock(isLocked => reportedLockStates.push(isLocked))
      firstSessionBus.close()
      await vi.advanceTimersByTimeAsync(60000)
      reconnectedSessionBus.deliver(screenSaverActiveChanged(true))
      reportedLockStates.should.deep.equal([true])
    })

    it('starts reporting the screen lock once a session bus that was missing appears', async () => {
      vi.useFakeTimers()
      const sessionBus = sessionBusDeliveringSignals()
      dbus.sessionBus
        .mockImplementationOnce(() => { throw new Error('Could not get session bus address') })
        .mockReturnValueOnce(sessionBus)
      const reportedLockStates = []
      await new GnomeSession().watchScreenLock(isLocked => reportedLockStates.push(isLocked))
      await vi.advanceTimersByTimeAsync(60000)
      sessionBus.deliver(screenSaverActiveChanged(true))
      reportedLockStates.should.deep.equal([true])
    })
  })
})
