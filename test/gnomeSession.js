import { vi, describe, it, beforeEach, afterEach } from 'vitest'
import 'chai/register-should'
import dbus from '@particle/dbus-next'
import GnomeSession from '../app/utils/gnomeSession.js'

vi.mock('@particle/dbus-next', () => ({ default: { sessionBus: vi.fn() } }))

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
})
