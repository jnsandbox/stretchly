// Keys are the names of shortcuts in the settings,
// values are break pause intervals in milliseconds (or null if not applicable)
const shortcuts = {
  pauseBreaksFor30MinutesShortcut: 30 * 60 * 1000,
  skipToNextScheduledBreakShortcut: null,
  skipToNextMiniBreakShortcut: null,
  skipToNextLongBreakShortcut: null
}

function calculateInterval (name) {
  return shortcuts[name]
}

function onShortcut ({ name, settings, log, breakPlanner, functions }) {
  switch (name) {
    case 'skipToNextScheduledBreakShortcut':
      log.info('Stretchly: skipping to next scheduled break by shortcut')
      if (breakPlanner._scheduledBreakType === 'break') {
        functions.skipToBreak()
      } else if (breakPlanner._scheduledBreakType === 'microbreak') {
        functions.skipToMicrobreak()
      }
      break
    case 'skipToNextMiniBreakShortcut':
      log.info('Stretchly: skipping to next Mini break by shortcut')
      functions.skipToMicrobreak()
      break
    case 'skipToNextLongBreakShortcut':
      log.info('Stretchly: skipping to next Long break by shortcut')
      functions.skipToBreak()
      break
    default: {
      log.info(`Stretchly: pausing breaks by shortcut (${name})`)
      const interval = calculateInterval(name)
      functions.pauseBreaks(interval)
      break
    }
  }
}

function setupBreak ({ name, shortcutText, settings, log, globalShortcut, breakPlanner, functions }) {
  const shortcut = globalShortcut.register(shortcutText, () => onShortcut({ name, settings, log, breakPlanner, functions }))

  if (shortcut) {
    log.info(`Stretchly: ${name} registration successful (${shortcutText})`)
  } else {
    log.warn(`Stretchly: ${name} registration failed`)
  }
}

function registerBreakShortcuts ({ settings, log, globalShortcut, breakPlanner, functions }) {
  for (const name of Object.keys(shortcuts)) {
    const shortcutText = settings.get(name)
    if (shortcutText === '') continue

    setupBreak({
      name,
      shortcutText,
      settings,
      log,
      globalShortcut,
      breakPlanner,
      functions
    })
  }
}

export {
  calculateInterval,
  onShortcut,
  registerBreakShortcuts,
  setupBreak
}
