import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ChakraProvider } from '@chakra-ui/react'
import './index.css'
import { AppWithProviders } from './AppWithProviders'
import { chakraSystem } from './styles/theme'

const preventContextMenu = (event: MouseEvent) => event.preventDefault()
document.addEventListener('contextmenu', preventContextMenu)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    document.removeEventListener('contextmenu', preventContextMenu)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChakraProvider value={chakraSystem}>
      <AppWithProviders />
    </ChakraProvider>
  </StrictMode>,
)
