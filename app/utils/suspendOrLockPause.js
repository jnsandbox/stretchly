import log from 'electron-log/main.js'

// Pauses breaks while the system is suspended or the screen is locked, and resumes them after.
// Electron and GNOME can both report one screen lock, so a repeated lock is ignored.
class SuspendOrLockPause {
  constructor ({ settings, breakPlanner, pauseBreaks, resumeBreaks, updateTray }) {
    this.settings = settings
    this.breakPlanner = breakPlanner
    this.pauseBreaks = pauseBreaks
    this.resumeBreaks = resumeBreaks
    this.updateTray = updateTray
    this.pausedForSuspendOrLock = false
    this.isScreenLocked = false
    this.isWatchingGnome = false
    this.onSuspendOrLock = () => this.suspendOrLock()
    this.onResumeOrUnlock = () => this.resumeOrUnlock()
    this.onScreenLocked = () => this.screenLockChanged(true)
    this.onScreenUnlocked = () => this.screenLockChanged(false)
  }

  // Safe to call again: listeners are replaced, and GNOME is only watched once.
  listen (powerMonitor, gnomeSession) {
    powerMonitor.removeListener('suspend', this.onSuspendOrLock)
    powerMonitor.removeListener('lock-screen', this.onScreenLocked)
    powerMonitor.removeListener('resume', this.onResumeOrUnlock)
    powerMonitor.removeListener('unlock-screen', this.onScreenUnlocked)
    powerMonitor.on('suspend', this.onSuspendOrLock)
    powerMonitor.on('lock-screen', this.onScreenLocked)
    powerMonitor.on('resume', this.onResumeOrUnlock)
    powerMonitor.on('unlock-screen', this.onScreenUnlocked)
    if (!this.isWatchingGnome) {
      this.isWatchingGnome = true
      // Electron sees no screen lock when running on the X11 backend under GNOME.
      gnomeSession.watchScreenLock(isLocked => this.screenLockChanged(isLocked))
    }
  }

  screenLockChanged (isLocked) {
    if (isLocked) {
      if (this.isScreenLocked) return
      this.isScreenLocked = true
      this.suspendOrLock()
    } else if (this.isScreenLocked) {
      this.isScreenLocked = false
      this.resumeOrUnlock()
    } else {
      // An unlock that ends no lock, so there is no pause to end; timers may still have stalled.
      this.breakPlanner.correctScheduler()
      this.updateTray()
    }
  }

  suspendOrLock () {
    log.info('System: suspend or lock')
    if (this.settings.get('pauseForSuspendOrLock')) {
      if (this.breakPlanner.isPaused || this.breakPlanner.dndManager.isOnDnd ||
        this.breakPlanner.naturalBreaksManager.isSchedulerCleared ||
        this.breakPlanner.appExclusionsManager.isSchedulerCleared) {
        log.info('Stretchly: not pausing for suspendOrLock because paused already')
      } else {
        this.pausedForSuspendOrLock = true
        this.pauseBreaks(1, false)
        this.updateTray()
      }
    } else {
      log.info('Stretchly: not pausing for suspendOrLock because setting is disabled')
    }
  }

  resumeOrUnlock () {
    log.info('System: resume or unlock')
    if (this.pausedForSuspendOrLock) {
      this.pausedForSuspendOrLock = false
      this.resumeBreaks(false)
    } else {
      // correct the planner for the time spent in suspend
      this.breakPlanner.correctScheduler()
    }
    this.updateTray()
  }
}

export default SuspendOrLockPause
