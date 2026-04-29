import { Switch } from "../../../../components/ui/Switch";
import type { ToggleParam } from "../../../../types";
import { resolveLocalizedText, useI18n } from "../../../../i18n";

interface ToggleRendererProps {
  param: ToggleParam;
  value: boolean;
  disabled: boolean;
  onCommit: (value: boolean) => void;
}

/**
 * Pure render component: Toggle is discrete switch, no drag, direct commit.
 */
export function ToggleRenderer({
  param,
  value,
  disabled,
  onCommit,
}: ToggleRendererProps) {
  const { locale } = useI18n();
  const label = resolveLocalizedText(param.label, locale);

  return (
    <Switch
      checked={value}
      disabled={disabled}
      onChange={onCommit}
      label={label}
    />
  );
}

