import { ColorPicker } from "../../../../components/ui/ColorPicker";
import type { ColorParam } from "../../../../types";
import { resolveLocalizedText, useI18n } from "../../../../i18n";

interface ColorRendererProps {
  param: ColorParam;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
}

/**
 * Pure render component: only responsible for rendering ColorPicker and forwarding events.
 * Draft state is managed by parent ParamRenderer.
 */
export function ColorRenderer({
  param,
  value,
  disabled,
  onChange,
  onCommit,
}: ColorRendererProps) {
  const { locale } = useI18n();
  const label = resolveLocalizedText(param.label, locale);

  return (
    <ColorPicker
      value={value}
      disabled={disabled}
      label={label}
      onChange={onChange}
      onCommit={onCommit}
    />
  );
}
