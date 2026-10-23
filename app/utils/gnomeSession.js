import log from 'electron-log/main.js'
import dbus from '@particle/dbus-next'

// A reply slower than this would hold up the natural breaks check behind it.
const replyTimeoutMilliseconds = 1000

// Lock signals sent while the watch is down are lost, so it is set up again soon after.
const screenLockRetryMilliseconds = 30000

const screenSaverInterface = 'org.gnome.ScreenSaver'
const screenSaverPath = '/org/gnome/ScreenSaver'
const screenLockSignal = 'ActiveChanged'

// No sender in the rule: gnome-shell sends the signal itself, while the name may belong to
// an on-demand helper that is not running.
const screenLockMatchRule = `type='signal',interface='${screenSaverInterface}',path='${screenSaverPath}',member='${screenLockSignal}'`

// The session D-Bus connection, and GNOME's idle monitor and screen lock reached over it.
// A reading answers null when GNOME does not, so callers keep their other sources.
class GnomeSession {
  constructor () {
    this._sessionBus = null
    this._idleMonitor = null
    this._idleMonitorAnswering = null
    this._onScreenLockChanged = null
    this._screenLockWatched = null
    this._screenLockRetryTimer = null
  }

  // Calls onScreenLockChanged with true on GNOME's screen lock and false on unlock, and with
  // the current state each time the watch is set up, which corrects a change missed meanwhile.
  // Without a session bus or GNOME it never calls back, and keeps trying to set up the watch.
  async watchScreenLock (onScreenLockChanged) {
    this._onScreenLockChanged = onScreenLockChanged
    try {
      await this._call({
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'AddMatch',
        signature: 's',
        body: [screenLockMatchRule]
      })
      this._noteScreenLockWatched(true)
    } catch (error) {
      this._noteScreenLockWatched(false, error)
      this._retryScreenLockWatch()
      return
    }
    await this._reportCurrentScreenLock()
  }

  // A failed read reports nothing; the signals still arrive without it.
  async _reportCurrentScreenLock () {
    try {
      const reply = await this._call({
        destination: screenSaverInterface,
        path: screenSaverPath,
        interface: screenSaverInterface,
        member: 'GetActive'
      })
      this._onScreenLockChanged(reply.body[0])
    } catch (error) {}
  }

  _retryScreenLockWatch () {
    if (!this._onScreenLockChanged || this._screenLockRetryTimer) return
    this._screenLockRetryTimer = setTimeout(() => {
      this._screenLockRetryTimer = null
      this.watchScreenLock(this._onScreenLockChanged)
    }, screenLockRetryMilliseconds)
  }

  _noteScreenLockWatched (isWatched, error) {
    if (this._screenLockWatched === isWatched) return
    this._screenLockWatched = isWatched
    if (isWatched) {
      log.info('Stretchly: listening for GNOME screen lock')
    } else {
      log.info('Stretchly: cannot listen for GNOME screen lock, retrying:', error.message)
    }
  }

  _reportScreenLockSignal (message) {
    if (message.type === dbus.MessageType.SIGNAL &&
      message.interface === screenSaverInterface &&
      message.path === screenSaverPath &&
      message.member === screenLockSignal) {
      this._onScreenLockChanged?.(message.body[0])
    }
  }

  async idleMilliseconds () {
    try {
      // The lookup and the call both sit under the timeout.
      const idleMilliseconds = await this._withinReplyTimeout(sessionBus => this._readIdleMonitor(sessionBus))
      this._noteIdleMonitorAnswering(true)
      return idleMilliseconds
    } catch (error) {
      this._idleMonitor = null
      this._noteIdleMonitorAnswering(false, error)
      return null
    }
  }

  async _readIdleMonitor (sessionBus) {
    if (!this._idleMonitor) {
      const idleMonitorObject = await sessionBus
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
      sessionBus.on('error', () => this._dropSessionBus(sessionBus))
      sessionBus.on('close', () => this._dropSessionBus(sessionBus))
      sessionBus.on('message', message => this._reportScreenLockSignal(message))
    }
    return this._sessionBus
  }

  _dropSessionBus (sessionBus) {
    // A failing connection can send both error and close, and a disconnect sends close.
    if (this._sessionBus !== sessionBus) return
    this._sessionBus = null
    this._idleMonitor = null
    // The match rule went with the connection.
    this._retryScreenLockWatch()
  }

  _call (messageFields) {
    return this._withinReplyTimeout(sessionBus => sessionBus.call(new dbus.Message(messageFields)))
  }

  // dbus-next never rejects a request left pending on a failed connection, so every
  // request runs under this timeout. A connection that stops replying may never send
  // error or close either, so it is dropped and the next request connects again.
  async _withinReplyTimeout (request) {
    const sessionBus = this._getOrCreateSessionBus()
    let timeout
    const timeoutPromise = new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        this._dropSessionBus(sessionBus)
        sessionBus.disconnect()
        reject(new Error('no reply from GNOME'))
      }, replyTimeoutMilliseconds)
    })
    try {
      return await Promise.race([request(sessionBus), timeoutPromise])
    } finally {
      clearTimeout(timeout)
    }
  }
}

export default GnomeSession
