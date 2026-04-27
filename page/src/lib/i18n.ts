/**
 * Lightweight i18n for extension pages.
 *
 * Reads the initial locale from `window.__SKYDIMO_EXT_PAGE__.locale`
 * (injected by Tauri), falling back to `navigator.language` detection then `en-US`.
 *
 * Supports real-time locale sync via `setLocale()` + change listeners for React reactivity.
 */

import { useSyncExternalStore } from 'react'
import enUS from './locales/en-US.json'
import zhCN from './locales/zh-CN.json'
import zhTW from './locales/zh-TW.json'
import de from './locales/de.json'
import fr from './locales/fr.json'
import es from './locales/es.json'
import ru from './locales/ru.json'
import tr from './locales/tr.json'

type Messages = Record<string, string>

const bundles: Record<string, Messages> = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'de': de,
  'fr': fr,
  'es': es,
  'ru': ru,
  'tr': tr,
}

const supportedLocales = Object.keys(bundles)
const DEFAULT_LOCALE = 'en-US'

function resolveLocale(): string {
  // 1. From host injection or URL query param
  const injected = window.__SKYDIMO_EXT_PAGE__?.locale
    ?? new URLSearchParams(window.location.search).get('locale')
  if (injected && supportedLocales.includes(injected)) return injected

  // 2. Base-language matching from navigator
  const preferred =
    typeof navigator !== 'undefined'
      ? [navigator.language, ...(navigator.languages ?? [])].filter(Boolean)
      : []

  for (const candidate of preferred) {
    if (supportedLocales.includes(candidate)) return candidate
    const base = candidate.split('-')[0]
    const match = supportedLocales.find(l => l.split('-')[0] === base)
    if (match) return match
  }

  return DEFAULT_LOCALE
}

let currentLocale = resolveLocale()
let currentMessages = bundles[currentLocale] ?? bundles[DEFAULT_LOCALE]

/* ── Change listeners for React reactivity ── */
const listeners = new Set<() => void>()

function emitChange() {
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function getSnapshot() {
  return currentLocale
}

export function getLocale(): string {
  return currentLocale
}

/** Translate a key. Returns the key itself if no translation is found. */
export function t(key: string): string {
  return currentMessages[key] ?? bundles[DEFAULT_LOCALE]?.[key] ?? key
}

export function setLocale(locale: string) {
  if (!supportedLocales.includes(locale) || locale === currentLocale) return
  currentLocale = locale
  currentMessages = bundles[locale] ?? bundles[DEFAULT_LOCALE]
  emitChange()
}

/** React hook that triggers re-render when locale changes. Returns current locale. */
export function useLocale(): string {
  return useSyncExternalStore(subscribe, getSnapshot)
}
