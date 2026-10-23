import log from 'electron-log/main.js'
import dbus from '@particle/dbus-next'

// A reply slower than this would hold up the natural breaks check behind it.
const replyTimeoutMilliseconds = 1000

// GNOME's own view of the session, read over the session D-Bus. Every reading
// answers null when GNOME does not, so callers keep their other sources.
class GnomeSession {
  constructor () {
    this._sessionBus = null
    this._failureLogged = false
  }

  async idleMilliseconds () {
    try {
      const idleMonitorObject = await this._getOrCreateSessionBus()
        .getProxyObject('org.gnome.Mutter.IdleMonitor', '/org/gnome/Mutter/IdleMonitor/Core')
      const idleMonitor = idleMonitorObject.getInterface('org.gnome.Mutter.IdleMonitor')
      return Number(await this._withinReplyTimeout(idleMonitor.GetIdletime()))
    } catch (error) {
      if (!this._failureLogged) {
        log.info('Stretchly: GNOME idle monitor unavailable, using system idle time:', error.message)
        this._failureLogged = true
      }
      return null
    }
  }

  _getOrCreateSessionBus () {
    if (!this._sessionBus) {
      const sessionBus = dbus.sessionBus()
      this._sessionBus = sessionBus
      sessionBus.on('error', () => { this._sessionBus = null })
      sessionBus.on('close', () => { this._sessionBus = null })
    }
    return this._sessionBus
  }

  _withinReplyTimeout (replyPromise) {
    let timeout
    const timeoutPromise = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('no reply from GNOME')), replyTimeoutMilliseconds)
    })
    return Promise.race([replyPromise, timeoutPromise]).finally(() => clearTimeout(timeout))
  }
}

export default GnomeSession
