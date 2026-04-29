import {
  Box,
  ColorPicker as ChakraColorPicker,
  HStack,
  IconButton,
  Portal,
  Text,
  Wrap,
  parseColor,
} from "@chakra-ui/react";
import { Pipette, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

const FALLBACK_COLOR = "#ffffff";

export interface MultiColorPickerProps {
  value: string[];
  label?: ReactNode;
  onChange?: (value: string[]) => void;
  onCommit?: (value: string[]) => void;
  disabled?: boolean;
  fixedCount?: number;
  minCount?: number;
  maxCount?: number;
}

interface SwatchPickerProps {
  index: number;
  value: string;
  disabled: boolean;
  canRemove: boolean;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  onRemove: () => void;
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

function SwatchPicker({
  index,
  value,
  disabled,
  canRemove,
  onChange,
  onCommit,
  onRemove,
}: SwatchPickerProps) {
  const externalColor = useMemo(() => safeParseColor(value), [value]);
  const externalHex = useMemo(() => externalColor.toString("hex"), [externalColor]);
  const [internalColor, setInternalColor] = useState(() => externalColor);
  const internalHex = useMemo(() => internalColor.toString("hex"), [internalColor]);

  useEffect(() => {
    if (externalHex !== internalHex) {
      setInternalColor(externalColor);
    }
  }, [externalColor, externalHex, internalHex]);

  const isEyeDropperSupported = useMemo(() => {
    return typeof window !== "undefined" && "EyeDropper" in window;
  }, []);

  return (
    <Box position="relative" className="group">
      <ChakraColorPicker.Root
        size="sm"
        value={internalColor}
        onValueChange={(details) => {
          setInternalColor(details.value);
          onChange(details.value.toString("hex"));
        }}
        onValueChangeEnd={(details) => {
          setInternalColor(details.value);
          onCommit(details.value.toString("hex"));
        }}
        disabled={disabled}
        lazyMount
        unmountOnExit
      >
        <ChakraColorPicker.Trigger
          aria-label={`Edit color ${index + 1}`}
          p="0"
          width="10"
          height="10"
          borderRadius="10px"
          overflow="hidden"
          border="1px solid"
          borderColor="var(--border-strong)"
          boxShadow="var(--shadow-control)"
          cursor={disabled ? "not-allowed" : "pointer"}
          transition="transform 0.18s ease, border-color 0.18s ease, opacity 0.18s ease"
          _hover={
            disabled
              ? undefined
              : {
                  borderColor: "var(--accent-color)",
                  transform: "translateY(-1px)",
                }
          }
          _focusVisible={{
            outline: "2px solid var(--accent-color)",
            outlineOffset: "2px",
          }}
        >
          <ChakraColorPicker.ValueSwatch width="full" height="full" />
        </ChakraColorPicker.Trigger>

        <Portal>
          <ChakraColorPicker.Positioner>
            <ChakraColorPicker.Content
              bg="var(--bg-popover)"
              backdropFilter="none"
              display="flex"
              flexDirection="column"
              gap="3"
            >
              <ChakraColorPicker.Area>
                <ChakraColorPicker.AreaBackground />
                <ChakraColorPicker.AreaThumb />
              </ChakraColorPicker.Area>

              <HStack gap="4" align="center">
                <ChakraColorPicker.EyeDropperTrigger asChild>
                  <IconButton
                    aria-label="Pick color from screen"
                    size="xs"
                    variant="outline"
                    disabled={disabled || !isEyeDropperSupported}
                  >
                    <Pipette size={14} />
                  </IconButton>
                </ChakraColorPicker.EyeDropperTrigger>

                <ChakraColorPicker.ChannelSlider channel="hue" flex="1">
                  <ChakraColorPicker.ChannelSliderTrack />
                  <ChakraColorPicker.ChannelSliderThumb />
                </ChakraColorPicker.ChannelSlider>
              </HStack>

              <ChakraColorPicker.ChannelInput channel="hex" />
            </ChakraColorPicker.Content>
          </ChakraColorPicker.Positioner>
        </Portal>

        <ChakraColorPicker.HiddenInput tabIndex={-1} />
      </ChakraColorPicker.Root>

      {canRemove ? (
        <IconButton
          aria-label={`Remove color ${index + 1}`}
          size="xs"
          minWidth="5"
          height="5"
          position="absolute"
          top="-1.5"
          right="-1.5"
          borderRadius="full"
          border="1px solid"
          borderColor="var(--border-strong)"
          bg="var(--bg-popover)"
          color="var(--text-primary)"
          boxShadow="var(--shadow-control)"
          opacity={0}
          pointerEvents="none"
          transition="opacity 0.18s ease, transform 0.18s ease"
          _groupHover={{ opacity: 1, pointerEvents: "auto", transform: "scale(1.02)" }}
          _focusVisible={{ opacity: 1, pointerEvents: "auto" }}
          _hover={{ bg: "var(--bg-card-hover)" }}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X size={12} />
        </IconButton>
      ) : null}
    </Box>
  );
}

export function MultiColorPicker({
  value,
  label,
  onChange,
  onCommit,
  disabled = false,
  fixedCount,
  minCount,
  maxCount,
}: MultiColorPickerProps) {
  const minItems = fixedCount ?? minCount ?? 0;
  const maxItems = fixedCount ?? maxCount;
  const canAdd = !disabled && (maxItems === undefined || value.length < maxItems);
  const canRemove = !disabled && fixedCount === undefined && value.length > minItems;

  const updateColor = useCallback(
    (index: number, nextColor: string, commit: boolean) => {
      const next = value.map((color, colorIndex) => (colorIndex === index ? nextColor : color));
      if (commit) {
        onCommit?.(next);
        return;
      }
      onChange?.(next);
    },
    [onChange, onCommit, value],
  );

  const handleAdd = useCallback(() => {
    if (!canAdd) return;
    const seed = value[value.length - 1] ?? FALLBACK_COLOR;
    onCommit?.([...value, seed]);
  }, [canAdd, onCommit, value]);

  const handleRemove = useCallback(
    (index: number) => {
      if (!canRemove) return;
      onCommit?.(value.filter((_, colorIndex) => colorIndex !== index));
    },
    [canRemove, onCommit, value],
  );

  return (
    <Box display="flex" flexDirection="column" gap="3">
      <HStack justify="space-between" align="center" gap="3">
        {typeof label === "string" ? (
          <Text fontSize="sm" fontWeight="medium" color="var(--text-primary)">
            {label}
          </Text>
        ) : (
          label
        )}

        {canAdd ? (
          <IconButton
            aria-label="Add color"
            size="xs"
            variant="ghost"
            color="var(--text-primary)"
            border="1px solid"
            borderColor="var(--border-strong)"
            bg="transparent"
            _hover={{ bg: "var(--bg-card-hover)" }}
            onClick={handleAdd}
          >
            <Plus size={14} />
          </IconButton>
        ) : null}
      </HStack>

      <Wrap gap="2">
        {value.map((color, index) => (
          <SwatchPicker
            key={index}
            index={index}
            value={color}
            disabled={disabled}
            canRemove={canRemove}
            onChange={(nextColor) => updateColor(index, nextColor, false)}
            onCommit={(nextColor) => updateColor(index, nextColor, true)}
            onRemove={() => handleRemove(index)}
          />
        ))}
      </Wrap>
    </Box>
  );
}
