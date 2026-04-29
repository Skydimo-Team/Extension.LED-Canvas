import { HStack, Slider as ChakraSlider } from "@chakra-ui/react";
import * as React from "react";

export type SliderValue = number | [number, number];

export interface SliderProps
  extends Omit<
    ChakraSlider.RootProps,
    | "value"
    | "defaultValue"
    | "onValueChange"
    | "onValueChangeEnd"
    | "onChange"
    | "onChangeCapture"
    | "min"
    | "max"
    | "step"
  > {
  label: React.ReactNode;
  value: SliderValue;
  min: number;
  max: number;
  step?: number;

  /**
   * Real-time update (during drag).
   */
  onChange: (value: SliderValue) => void;

  /**
   * Settlement update (on release/end drag).
   */
  onCommit?: (value: SliderValue) => void;

  /**
   * Right-side value text display (takes priority over formatValue).
   */
  valueText?: React.ReactNode;

  /**
   * Used to format value to UI text/node.
   * Only effective when valueText is not provided.
   */
  formatValue?: (value: SliderValue) => React.ReactNode;
}

function isRangeValue(value: SliderValue): value is [number, number] {
  return Array.isArray(value);
}

function toArrayValue(value: SliderValue): number[] {
  return isRangeValue(value) ? value : [value];
}

/**
 * Unified styled application-level Slider component.
 *
 * - Default uses Chakra v3 Slider (outline + sm), and relies on `src/styles/theme.ts` slider slot recipe for theming.
 * - Default thumbAlignment="center", makes thumb more centered and consistent.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  valueText,
  formatValue,
  size,
  variant,
  thumbAlignment,
  ...rest
}: SliderProps) {
  const isRange = isRangeValue(value);
  const sliderValue = React.useMemo(() => toArrayValue(value), [value]);

  const computedValueText = React.useMemo(() => {
    if (valueText !== undefined) return valueText;
    if (formatValue) return formatValue(value);
    return isRange ? `${sliderValue[0]} - ${sliderValue[1]}` : sliderValue[0];
  }, [formatValue, isRange, sliderValue, value, valueText]);

  const normalizeValue = React.useCallback(
    (next: number[]): SliderValue => {
      if (!isRange) {
        return next[0] ?? min;
      }

      const start = next[0] ?? min;
      const end = next[1] ?? start;
      return start <= end ? [start, end] : [end, start];
    },
    [isRange, min],
  );

  const shouldRenderHeader = label != null || computedValueText != null;

  return (
    <ChakraSlider.Root
      size={size ?? "sm"}
      variant={variant ?? "solid"}
      thumbAlignment={thumbAlignment ?? "center"}
      min={min}
      max={max}
      step={step}
      value={sliderValue}
      onValueChange={(d) => onChange(normalizeValue(d.value))}
      onValueChangeEnd={(d) => onCommit?.(normalizeValue(d.value))}
      {...rest}
    >
      {shouldRenderHeader && (
        <HStack justify="space-between">
          {label != null && <ChakraSlider.Label>{label}</ChakraSlider.Label>}
          {computedValueText != null && (
            <ChakraSlider.ValueText>{computedValueText}</ChakraSlider.ValueText>
          )}
        </HStack>
      )}
      <ChakraSlider.Control>
        <ChakraSlider.Track>
          <ChakraSlider.Range />
        </ChakraSlider.Track>
        <ChakraSlider.Thumbs />
      </ChakraSlider.Control>
    </ChakraSlider.Root>
  );
}
