import { Select } from "../../../../components/ui/Select";
import type { SelectParam } from "../../../../types";
import { resolveLocalizedText, useI18n } from "../../../../i18n";

interface SelectRendererProps {
  param: SelectParam;
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}

/**
 * Pure render component: Select is discrete selection, no drag, direct commit.
 */
export function SelectRenderer({
  param,
  value,
  disabled,
  onCommit,
}: SelectRendererProps) {
  const { locale } = useI18n();
  const label = resolveLocalizedText(param.label, locale);

  if (param.options.length === 0) {
    return <div className="select-renderer-empty">No options available.</div>;
  }

  return (
    <Select
      value={value}
      options={param.options.map((o) => ({
        value: o.value,
        label: resolveLocalizedText(o.label, locale),
      }))}
      onChange={onCommit}
      disabled={disabled}
      label={label}
      valueText={`${param.options.length} option${param.options.length > 1 ? "s" : ""}`}
    />
  );
}
