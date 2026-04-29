import { Text } from "@chakra-ui/react";
import type { SliderParam } from "../../../../types";
import { Slider } from "../../../../components/ui/Slider";
import { resolveLocalizedText, useI18n } from "../../../../i18n";

interface SliderRendererProps {
  param: SliderParam;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}

/**
 * Pure render component: only responsible for rendering Slider and forwarding events.
 * Draft state is managed by parent ParamRenderer.
 */
export function SliderRenderer({
  param,
  value,
  disabled,
  onChange,
  onCommit,
}: SliderRendererProps) {
  const { locale } = useI18n();
  const label = resolveLocalizedText(param.label, locale);

  const formatParamValue = (p: SliderParam, v: number) => {
    if (p.step < 1) return v.toFixed(1);
    return Math.round(v).toString();
  };

  return (
    <Slider
      label={<Text>{label}</Text>}
      min={param.min}
      max={param.max}
      step={param.step}
      value={value}
      onChange={(next) => onChange(next as number)}
      onCommit={(next) => onCommit(next as number)}
      disabled={disabled}
      formatValue={(next) => formatParamValue(param, next as number)}
    />
  );
}

