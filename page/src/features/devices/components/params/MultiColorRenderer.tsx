import { MultiColorPicker } from "../../../../components/ui/MultiColorPicker";
import type { MultiColorParam } from "../../../../types";
import { resolveLocalizedText, useI18n } from "../../../../i18n";

interface MultiColorRendererProps {
  param: MultiColorParam;
  value: string[];
  disabled: boolean;
  onChange: (value: string[]) => void;
  onCommit: (value: string[]) => void;
}

export function MultiColorRenderer({
  param,
  value,
  disabled,
  onChange,
  onCommit,
}: MultiColorRendererProps) {
  const { locale } = useI18n();
  const label = resolveLocalizedText(param.label, locale);

  return (
    <MultiColorPicker
      value={value}
      disabled={disabled}
      label={label}
      fixedCount={param.fixedCount}
      minCount={param.minCount}
      maxCount={param.maxCount}
      onChange={onChange}
      onCommit={onCommit}
    />
  );
}
