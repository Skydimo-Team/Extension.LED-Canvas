import { useMemo } from 'react'
import { useLocale } from '@/lib/i18n'
import type { LocalizedText } from '@/types'

const DEFAULT_LOCALE = 'en-US'

function getFirstTranslation(byLocale?: Record<string, string>): string | undefined {
  if (!byLocale) return undefined
  return Object.values(byLocale)[0]
}

export function resolveLocalizedText(text: LocalizedText, locale: string): string {
  return (
    text.byLocale?.[locale]
    ?? text.byLocale?.[DEFAULT_LOCALE]
    ?? getFirstTranslation(text.byLocale)
    ?? text.raw
  )
}

export function useI18n() {
  const locale = useLocale()

  return useMemo(() => ({ locale }), [locale])
}