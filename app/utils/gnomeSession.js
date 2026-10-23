import log from 'electron-log/main.js'
import dbus from '@particle/dbus-next'

// A reply slower than this would hold up the natural breaks check behind it.
const replyTimeoutMilliseconds = 1000

// The session D-Bus connection and GNOME's idle monitor reached over it.
// A reading answers null when GNOME does not, so callers keep their other sources.
class GnomeSession {
  constructor () {
    this._sessionBus = null
    this._idleMonitor = null
    this._idleMonitorAnswering = null
  }

  async idleMilliseconds () {
    try {
      // dbus-next never rejects requests left pending on a failed connection,
      // so the lookup and the call both sit under the timeout.
      const idleMilliseconds = await this._withinReplyTimeout(this._readIdleMonitor())
      this._noteIdleMonitorAnswering(true)
      return idleMilliseconds
    } catch (error) {
      this._idleMonitor = null
      this._noteIdleMonitorAnswering(false, error)
      return null
    }
  }

  async _readIdleMonitor () {
    if (!this._idleMonitor) {
      const idleMonitorObject = await this._getOrCreateSessionBus()
        .getProxyObject('org.gnome.Mutter.IdleMonitor', '/org/gnome/Mutter/IdleMonitor/Core')
      this._idleMonitor = idleMonitorObject.getInterface('org.gnome.Mutter.IdleMonitor')
    }
    return Number(await this._idleMonitor.GetIdletime())
  }

  _noteIdleMonitorAnswering (isAnswering, error) {
    if (this._idleMonitorAnswering === isAnswering) return
    this._idleMonitorAnswering = isAnswering
    if (isAnswering) {
      log.info('Stretchly: reading idle time from GNOME idle monitor')
    } else {
      log.info('Stretchly: GNOME idle monitor unavailable, using system idle time:', error.message)
    }
  }

  _getOrCreateSessionBus () {
    if (!this._sessionBus) {
      const sessionBus = dbus.sessionBus()
      this._sessionBus = sessionBus
      const dropSessionBus = () => {
        this._sessionBus = null
        this._idleMonitor = null
      }
      sessionBus.on('error', dropSessionBus)
      sessionBus.on('close', dropSessionBus)
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
