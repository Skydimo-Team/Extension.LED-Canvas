import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ChakraProvider, LocaleProvider } from '@chakra-ui/react'
import './index.css'
import App from './App.tsx'
import { useLocale } from './lib/i18n'
import { chakraSystem } from './styles/theme'

const preventContextMenu = (event: MouseEvent) => event.preventDefault()
document.addEventListener('contextmenu', preventContextMenu)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    document.removeEventListener('contextmenu', preventContextMenu)
  })
}

function AppWithProviders() {
  const locale = useLocale()

  return (
    <LocaleProvider locale={locale}>
      <App />
    </LocaleProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChakraProvider value={chakraSystem}>
      <AppWithProviders />
    </ChakraProvider>
  </StrictMode>,
)
