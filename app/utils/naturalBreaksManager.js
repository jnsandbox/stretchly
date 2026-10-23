import EventEmitter from 'events'
import log from 'electron-log/main.js'
import { desktopIdle } from 'node-desktop-idle-v2'
import { powerMonitor } from 'electron'

class NaturalBreaksManager extends EventEmitter {
  constructor (settings, gnomeSession = null) {
    super()
    this.settings = settings
    this.gnomeSession = gnomeSession
    this.usingNaturalBreaks = settings.get('naturalBreaks')
    this.naturalBreaksCheckInterval = settings.get('naturalBreaksCheckInterval')
    this.timer = null
    this.isOnNaturalBreak = false
    this.isSchedulerCleared = false
    if (this.usingNaturalBreaks) {
      this.start()
    }
  }

  start () {
    if (this.timer) return
    this.usingNaturalBreaks = true
    desktopIdle.startMonitoring()
    this._checkIdleTime()
    log.info('Stretchly: starting Idle time monitoring')
  }

  stop () {
    if (!this.timer) return
    this.usingNaturalBreaks = false
    this.isOnNaturalBreak = false
    this.isSchedulerCleared = false
    clearInterval(this.timer)
    this.timer = null
    desktopIdle.stopMonitoring()
    log.info('Stretchly: stopping Idle time monitoring')
  }

  // Under the X11 backend Electron only sees input sent to X11 windows, so GNOME's
  // own idle monitor is preferred whenever it answers.
  async readIdleTime () {
    if (!this.usingNaturalBreaks) return 0
    const gnomeIdleMilliseconds = this.gnomeSession ? await this.gnomeSession.idleMilliseconds() : null
    return gnomeIdleMilliseconds ?? (powerMonitor.getSystemIdleTime() || desktopIdle.getIdleTime()) * 1000
  }

  _checkIdleTime () {
    let lastIdleTime = 0
    let isReadingIdleTime = false
    let lastReadFailed = false
    const timer = setInterval(async () => {
      if (isReadingIdleTime) return
      isReadingIdleTime = true
      let idleTime
      try {
        idleTime = await this.readIdleTime()
        lastReadFailed = false
      } catch (error) {
        if (!lastReadFailed) log.error('Stretchly: could not read idle time:', error)
        lastReadFailed = true
        return
      } finally {
        isReadingIdleTime = false
      }
      // stop() may have run while the idle time was being read
      if (this.timer !== timer) return
      if (!this.isOnNaturalBreak && idleTime > 20000) {
        this.isOnNaturalBreak = true
      }
      if (this.isOnNaturalBreak && idleTime < 20000) {
        this.isOnNaturalBreak = false
        if (lastIdleTime > this.settings.get('naturalBreaksInactivityResetTime')) {
          this.isSchedulerCleared = false
          this.emit('naturalBreakFinished', lastIdleTime)
        }
      }
      if (this.isOnNaturalBreak && idleTime > this.settings.get('naturalBreaksInactivityResetTime')) {
        this.isSchedulerCleared = true
        this.emit('clearBreakScheduler')
      }
      lastIdleTime = idleTime
    }, this.naturalBreaksCheckInterval)
    this.timer = timer
  }
}

export default NaturalBreaksManager
