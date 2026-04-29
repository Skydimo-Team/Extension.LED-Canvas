import {
  createSystem,
  defaultConfig,
  defineConfig,
  defineSlotRecipe,
  mergeConfigs,
} from '@chakra-ui/react'
import { sliderAnatomy } from '@chakra-ui/react/anatomy'

const sliderSlotRecipe = defineSlotRecipe({
  slots: sliderAnatomy.keys(),
  variants: {
    variant: {
      outline: {
        thumb: {
          bg: 'var(--slider-thumb-bg)',
        },
      },
    },
  },
})

export const chakraSystem = createSystem(
  mergeConfigs(
    defaultConfig,
    defineConfig({
      globalCss: {
        html: {
          bg: 'bg',
          colorPalette: 'accent',
        },
        body: {
          bg: 'bg',
          color: 'fg',
          fontFamily: 'var(--font-sans)',
        },
      },
      theme: {
        slotRecipes: {
          slider: sliderSlotRecipe,
        },
        semanticTokens: {
          colors: {
            fg: {
              DEFAULT: { value: 'var(--text-primary)' },
              muted: { value: 'var(--text-secondary)' },
            },
            bg: {
              DEFAULT: { value: 'var(--bg-app)' },
              muted: { value: 'var(--bg-card)' },
              subtle: { value: 'var(--bg-card-subtle)' },
              panel: { value: 'var(--bg-context-menu)' },
            },
            border: {
              DEFAULT: { value: 'var(--border-strong)' },
              muted: { value: 'var(--border-subtle)' },
              subtle: { value: 'var(--border-subtle)' },
            },
            accent: {
              solid: { value: 'var(--accent-color)' },
              contrast: { value: 'var(--accent-text)' },
              fg: { value: 'var(--accent-color)' },
              muted: { value: 'color-mix(in srgb, var(--accent-color) 20%, transparent)' },
              subtle: { value: 'color-mix(in srgb, var(--accent-color) 15%, transparent)' },
              emphasized: { value: 'var(--accent-hover)' },
              focusRing: { value: 'var(--accent-color)' },
            },
          },
        },
      },
    }),
  ),
)
