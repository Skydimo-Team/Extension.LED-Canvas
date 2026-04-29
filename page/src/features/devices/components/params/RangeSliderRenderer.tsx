import { Text } from "@chakra-ui/react";
import type { RangeSliderParam, RangeSliderValue } from "../../../../types";
import { Slider } from "../../../../components/ui/Slider";
import { resolveLocalizedText, useI18n } from "../../../../i18n";

interface RangeSliderRendererProps {
  param: RangeSliderParam;
  value: RangeSliderValue;
  disabled: boolean;
  onChange: (value: RangeSliderValue) => void;
  onCommit: (value: RangeSliderValue) => void;
}

function formatRangeValue(param: RangeSliderParam, value: RangeSliderValue) {
  const [start, end] = value;
  if (param.step < 1) {
    return `${start.toFixed(1)} - ${end.toFixed(1)}`;
  }
  return `${Math.round(start)} - ${Math.round(end)}`;
}

export function RangeSliderRenderer({
  param,
  value,
  disabled,
  onChange,
  onCommit,
}: RangeSliderRendererProps) {
  const { locale } = useI18n();
  const label = resolveLocalizedText(param.label, locale);

  return (
    <Slider
      label={<Text>{label}</Text>}
      min={param.min}
      max={param.max}
      step={param.step}
      value={value}
      onChange={(next) => onChange(next as RangeSliderValue)}
      onCommit={(next) => onCommit(next as RangeSliderValue)}
      disabled={disabled}
      formatValue={(next) => formatRangeValue(param, next as RangeSliderValue)}
    />
  );
}
