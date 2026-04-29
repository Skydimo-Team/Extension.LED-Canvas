export type ParamDependencyBehavior = 'hide' | 'disable';

export interface ParamDependency {
  key?: string;
  equals?: number;
  notEquals?: number;
  behavior?: ParamDependencyBehavior;
}

export type EffectParamScalarValue = number | boolean | string;
export type MultiColorValue = string[];
export type RangeSliderValue = [number, number];
export type EffectParamValue = EffectParamScalarValue | MultiColorValue | RangeSliderValue;

export interface LocalizedText {
  /** Raw value from backend/plugin (may be plain string or i18n key) */
  raw: string;
  /** Optional per-locale text map, e.g. { "en-US": "Speed", "zh-CN": "Velocity" } */
  byLocale?: Record<string, string>;
}

interface EffectParamBase {
  key: string;
  label: LocalizedText;
  group?: LocalizedText;
  dependency?: ParamDependency;
}

export interface SliderParam extends EffectParamBase {
  type: 'slider';
  default: number;
  min: number;
  max: number;
  step: number;
}

export interface RangeSliderParam extends EffectParamBase {
  type: 'range-slider';
  default: RangeSliderValue;
  min: number;
  max: number;
  step: number;
}

export interface SelectOption {
  label: LocalizedText;
  value: number;
}

export interface SelectParam extends EffectParamBase {
  type: 'select';
  default: number;
  options: SelectOption[];
}

export interface ToggleParam extends EffectParamBase {
  type: 'toggle';
  default: boolean;
}

export interface ColorParam extends EffectParamBase {
  type: 'color';
  default: string;
}

export interface MultiColorParam extends EffectParamBase {
  type: 'multi-color';
  default: string[];
  fixedCount?: number;
  minCount?: number;
  maxCount?: number;
}

export type EffectParam =
  | SliderParam
  | RangeSliderParam
  | SelectParam
  | ToggleParam
  | ColorParam
  | MultiColorParam;

export interface EffectInfo {
  id: string;
  name: LocalizedText;
  description?: LocalizedText;
  group?: LocalizedText;
  icon?: string;
  permissions?: string[];
  params?: EffectParam[];
}
