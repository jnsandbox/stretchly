import { vi } from 'vitest'
import dbus from '@particle/dbus-next'

// A session bus that accepts match rules, answers GNOME's GetActive with screenSaverActive
// (failing when it is undefined), and lets the test deliver messages on it or close it.
export function sessionBusDeliveringSignals ({ screenSaverActive } = {}) {
  const listeners = { message: [], error: [], close: [] }
  return {
    on: vi.fn((eventName, listener) => { listeners[eventName].push(listener) }),
    call: vi.fn(async (message) => {
      if (message.member !== 'GetActive') return { body: [] }
      if (screenSaverActive === undefined) throw new Error('org.freedesktop.DBus.Error.ServiceUnknown')
      return { body: [screenSaverActive] }
    }),
    deliver: (message) => listeners.message.forEach(listener => listener(message)),
    close: () => listeners.close.forEach(listener => listener())
  }
}

export function screenSaverActiveChanged (isActive) {
  return new dbus.Message({
    type: dbus.MessageType.SIGNAL,
    path: '/org/gnome/ScreenSaver',
    interface: 'org.gnome.ScreenSaver',
    member: 'ActiveChanged',
    signature: 'b',
    body: [isActive]
  })
}
