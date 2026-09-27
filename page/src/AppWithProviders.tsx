import { LocaleProvider } from '@chakra-ui/react'
import App from './App'
import { useLocale } from './lib/i18n'

export function AppWithProviders() {
  const locale = useLocale()

  return (
    <LocaleProvider locale={locale}>
      <App />
    </LocaleProvider>
  )
}
