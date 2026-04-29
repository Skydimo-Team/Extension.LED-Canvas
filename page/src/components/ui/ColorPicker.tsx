/**
 * Chakra UI v3 ColorPicker wrapper
 *
 * Goal: Fully reuse Chakra UI components and styles (avoid custom styles as much as possible).
 * This only handles "value type adaptation": external uses string(hex), Chakra internal uses Color object.
 */
import {
  Box,
  ColorPicker as ChakraColorPicker,
  HStack,
  IconButton,
  Portal,
  parseColor,
} from "@chakra-ui/react";
import { Pipette } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

const FALLBACK_COLOR = "#ffffff";
const COLOR_HISTORY_KEY = "skydimo-color-history";
const MAX_HISTORY = 7;

function loadColorHistory(): string[] {
  try {
    const raw = localStorage.getItem(COLOR_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveColorHistory(history: string[]) {
  try {
    localStorage.setItem(
      COLOR_HISTORY_KEY,
      JSON.stringify(history.slice(0, MAX_HISTORY)),
    );
  } catch {
    // ignore quota errors
  }
}

function pushColorToHistory(hex: string): string[] {
  const normalized = hex.toLowerCase();
  const prev = loadColorHistory().filter((c) => c !== normalized);
  const next = [normalized, ...prev].slice(0, MAX_HISTORY);
  saveColorHistory(next);
  return next;
}

export interface ColorPickerProps {
  value: string;
  label?: ReactNode;
  onChange?: (value: string) => void;
  onCommit?: (value: string) => void;
  disabled?: boolean;
}

function normalizeColorInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return FALLBACK_COLOR;
  if (!trimmed.startsWith("#") && !trimmed.includes("(")) return `#${trimmed}`;
  return trimmed;
}

function safeParseColor(input: string) {
  try {
    return parseColor(normalizeColorInput(input));
  } catch {
    return parseColor(FALLBACK_COLOR);
  }
}

export function ColorPicker({
  value,
  label,
  onChange,
  onCommit,
  disabled = false,
}: ColorPickerProps) {
  // Note: hex string cannot express hue (e.g. #000000 / grayscale).
  // If we re-parse from hex on every render, we lose hue when dragging to "bottom" (brightness=0),
  // Chakra internal falls back to hue=0, appearing as "hue forced to red".
  // Here we use internal Color state to carry full HSVA info, and don't overwrite internal state when external returns same hex.
  const externalColor = useMemo(() => safeParseColor(value), [value]);
  const externalHex = useMemo(() => externalColor.toString("hex"), [externalColor]);

  const [internalColor, setInternalColor] = useState(() => externalColor);
  const internalHex = useMemo(() => internalColor.toString("hex"), [internalColor]);

  useEffect(() => {
    // Only sync when external value is actually different from internal value.
    // This way when parent component writes back the same hex during drag (especially #000000), it won't erase hue info.
    if (externalHex !== internalHex) {
      setInternalColor(externalColor);
    }
  }, [externalColor, externalHex, internalHex]);

  const isEyeDropperSupported = useMemo(() => {
    // Chakra's EyeDropperTrigger depends on browser EyeDropper API.
    // Usually available in Tauri(Windows/WebView2), but still handle fallback.
    return typeof window !== "undefined" && "EyeDropper" in window;
  }, []);

  const [colorHistory, setColorHistory] = useState<string[]>(loadColorHistory);

  const handleValueChangeEnd = useCallback(
    (details: { value: ReturnType<typeof parseColor> }) => {
      setInternalColor(details.value);
      const hex = details.value.toString("hex");
      onCommit?.(hex);
      setColorHistory(pushColorToHistory(hex));
    },
    [onCommit],
  );

  const handleHistoryClick = useCallback(
    (hex: string) => {
      const color = safeParseColor(hex);
      setInternalColor(color);
      onChange?.(hex);
      onCommit?.(hex);
      setColorHistory(pushColorToHistory(hex));
    },
    [onChange, onCommit],
  );

  return (
    <ChakraColorPicker.Root
      size="sm"
      value={internalColor}
      onValueChange={(details) => {
        setInternalColor(details.value);
        onChange?.(details.value.toString("hex"));
      }}
      onValueChangeEnd={handleValueChangeEnd}
      disabled={disabled}
    >
      {label && <ChakraColorPicker.Label>{label}</ChakraColorPicker.Label>}

      <ChakraColorPicker.Control>
        <ChakraColorPicker.ChannelInput channel="hex" />
        <ChakraColorPicker.Trigger>
          <ChakraColorPicker.ValueSwatch />
        </ChakraColorPicker.Trigger>
      </ChakraColorPicker.Control>

      <Portal>
        <ChakraColorPicker.Positioner>
          <ChakraColorPicker.Content bg="var(--bg-popover)" backdropFilter="none">
            <ChakraColorPicker.Area>
              <ChakraColorPicker.AreaBackground />
              <ChakraColorPicker.AreaThumb />
            </ChakraColorPicker.Area>

            <ChakraColorPicker.ChannelSlider channel="hue">
              <ChakraColorPicker.ChannelSliderTrack />
              <ChakraColorPicker.ChannelSliderThumb />
            </ChakraColorPicker.ChannelSlider>

            <HStack gap="1" align="center" overflow="hidden" flexWrap="nowrap">
              <ChakraColorPicker.EyeDropperTrigger asChild>
                <IconButton
                  aria-label="Pick color from screen"
                  size="xs"
                  variant="outline"
                  disabled={disabled || !isEyeDropperSupported}
                  flexShrink={0}
                >
                  <Pipette size={14} />
                </IconButton>
              </ChakraColorPicker.EyeDropperTrigger>

              {colorHistory.map((hex) => (
                <Box
                  key={hex}
                  as="button"
                  aria-label={`Select ${hex}`}
                  onClick={() => handleHistoryClick(hex)}
                  bg={hex}
                  boxSize="7"
                  borderRadius="l2"
                  borderWidth="1px"
                  borderColor="border"
                  cursor="pointer"
                  flexShrink={0}
                  _hover={{ opacity: 0.8 }}
                />
              ))}
            </HStack>
          </ChakraColorPicker.Content>
        </ChakraColorPicker.Positioner>
      </Portal>

      <ChakraColorPicker.HiddenInput tabIndex={-1} />
    </ChakraColorPicker.Root>
  );
}
