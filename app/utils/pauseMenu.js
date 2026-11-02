// A pause only delays the break that was coming, so none lasts longer than these.
const pauseMinutesOffered = [10, 20, 30]
const longestPauseMilliseconds = Math.max(...pauseMinutesOffered) * 60 * 1000
const pauseShortcuts = { 30: 'pauseBreaksFor30MinutesShortcut' }

function pauseSubmenu ({ settings, i18next, pauseBreaks }) {
  return pauseMinutesOffered.map(minutes => ({
    label: i18next.t('utils.minutes', { count: minutes }),
    accelerator: (pauseShortcuts[minutes] && settings.get(pauseShortcuts[minutes])) || null,
    click: () => pauseBreaks(minutes * 60 * 1000)
  }))
}

export { longestPauseMilliseconds, pauseSubmenu }
