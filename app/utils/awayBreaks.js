import log from 'electron-log/main.js'

// A spell away runs while the screen is locked or the system is suspended, from whichever
// came first until both have ended. One that lasts naturalBreaksInactivityResetTime counts
// as a break; a shorter one leaves the schedule running.
// Electron and GNOME can both report one screen lock, so a repeated lock is ignored.
class AwayBreaks {
  constructor ({ settings, breakPlanner, breakLog, closeBreakPopup, updateTray }) {
    this.settings = settings
    this.breakPlanner = breakPlanner
    this.breakLog = breakLog
    this.closeBreakPopup = closeBreakPopup
    this.updateTray = updateTray
    this.isScreenLocked = false
    this.isSuspended = false
    this.spell = null
    this.isWatchingGnome = false
    this.onSuspended = () => this.suspendChanged(true)
    this.onResumed = () => this.suspendChanged(false)
    this.onScreenLocked = () => this.screenLockChanged(true)
    this.onScreenUnlocked = () => this.screenLockChanged(false)
    breakPlanner.on('naturalBreakCleared', () => {
      if (this.spell) this.spell.naturalBreakCleared = true
    })
  }

  // Safe to call again: listeners are replaced, and GNOME is only watched once.
  listen (powerMonitor, gnomeSession) {
    powerMonitor.removeListener('suspend', this.onSuspended)
    powerMonitor.removeListener('lock-screen', this.onScreenLocked)
    powerMonitor.removeListener('resume', this.onResumed)
    powerMonitor.removeListener('unlock-screen', this.onScreenUnlocked)
    powerMonitor.on('suspend', this.onSuspended)
    powerMonitor.on('lock-screen', this.onScreenLocked)
    powerMonitor.on('resume', this.onResumed)
    powerMonitor.on('unlock-screen', this.onScreenUnlocked)
    if (!this.isWatchingGnome) {
      this.isWatchingGnome = true
      // Electron sees no screen lock when running on the X11 backend under GNOME.
      gnomeSession.watchScreenLock(isLocked => this.screenLockChanged(isLocked))
    }
  }

  screenLockChanged (isLocked) {
    if (isLocked === this.isScreenLocked) {
      // An unlock that ends no lock ends no spell; timers may still have stalled.
      if (!isLocked) this.correctSchedule()
      return
    }
    this.isScreenLocked = isLocked
    log.info(`System: screen ${isLocked ? 'locked' : 'unlocked'}`)
    this.awayChanged('lock')
  }

  suspendChanged (isSuspended) {
    log.info(`System: ${isSuspended ? 'suspend' : 'resume'}`)
    if (isSuspended === this.isSuspended) {
      if (!isSuspended) this.correctSchedule()
      return
    }
    this.isSuspended = isSuspended
    this.awayChanged('suspend')
  }

  awayChanged (cause) {
    const isAway = this.isScreenLocked || this.isSuspended
    if (isAway && !this.spell) {
      // Wall-clock time, because idle time and timers stall across a suspend.
      this.spell = { cause, startedAt: Date.now(), naturalBreakCleared: false }
    } else if (!isAway && this.spell) {
      const spell = this.spell
      this.spell = null
      this.endSpell(spell)
    }
  }

  endSpell ({ cause, startedAt, naturalBreakCleared }) {
    const awayMilliseconds = Date.now() - startedAt
    if (!this.settings.get('pauseForSuspendOrLock') ||
      awayMilliseconds < this.settings.get('naturalBreaksInactivityResetTime') ||
      naturalBreakCleared || !this.isScheduleRunning()) {
      this.correctSchedule()
      return
    }
    this.breakLog.recordAwayBreak({
      awayMilliseconds, cause, scheduledBreakType: this.breakPlanner.plannedBreakType
    })
    this.closeBreakPopup()
    this.breakPlanner.reset()
    log.info(`Stretchly: restarting breaks after ${Math.round(awayMilliseconds / 1000)}s away`)
    this.updateTray()
  }

  // A natural break, Do Not Disturb, an app exclusion or a pause owns the restart of a stopped schedule.
  isScheduleRunning () {
    const breakPlanner = this.breakPlanner
    return !breakPlanner.isPaused && !breakPlanner.dndManager.isOnDnd &&
      !breakPlanner.naturalBreaksManager.isSchedulerCleared &&
      !breakPlanner.appExclusionsManager.isSchedulerCleared
  }

  // Brings forward a break that came due while timers were stalled.
  correctSchedule () {
    this.breakPlanner.correctScheduler()
    this.updateTray()
  }
}

export default AwayBreaks
