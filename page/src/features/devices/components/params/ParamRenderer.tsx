import { useEffect, useState } from "react";
import type { EffectParam, EffectParamValue } from "../../../../types";
import { ColorRenderer } from "./ColorRenderer";
import { MultiColorRenderer } from "./MultiColorRenderer";
import { RangeSliderRenderer } from "./RangeSliderRenderer";
import { SelectRenderer } from "./SelectRenderer";
import { SliderRenderer } from "./SliderRenderer";
import { ToggleRenderer } from "./ToggleRenderer";

interface ParamRendererProps {
  param: EffectParam;
  value: EffectParamValue;
  disabled: boolean;
  /**
   * High-frequency real-time changes (e.g., slider/color drag).
   * Note: Caller should avoid setState here that triggers large-scale re-renders; recommended to only do throttled backend sync.
   */
  onChange?: (value: EffectParamValue) => void;
  onCommit: (value: EffectParamValue) => void;
}

/**
 * Dispatcher component that decides which renderer to use based on param.type.
 *
 * Architecture notes:
 * - ParamRenderer manages draft state uniformly, isolating high-frequency updates during drag
 * - Each Renderer stays pure, only responsible for rendering and event forwarding
 * - By default only onCommit bubbles to DeviceDetail, avoiding full page re-render during drag
 * - If onChange is passed, it's used for "real-time refresh": throttled sync to backend without blocking UI
 */
export function ParamRenderer({ param, value, disabled, onChange, onCommit }: ParamRendererProps) {
  // Local draft state: high-frequency updates during drag are absorbed here, not bubbled to parent
  const [draft, setDraft] = useState<EffectParamValue>(value);

  // Sync when external value changes (e.g., backend refresh, switch effect)
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const handleChange = (next: EffectParamValue) => {
    setDraft(next);
    onChange?.(next);
  };

  const handleCommit = (next: EffectParamValue) => {
    setDraft(next);
    onCommit(next);
  };

  switch (param.type) {
    case "slider":
      return (
        <SliderRenderer
          param={param}
          value={draft as number}
          disabled={disabled}
          onChange={handleChange as (v: number) => void}
          onCommit={handleCommit as (v: number) => void}
        />
      );
    case "range-slider":
      return (
        <RangeSliderRenderer
          param={param}
          value={draft as [number, number]}
          disabled={disabled}
          onChange={handleChange as (v: [number, number]) => void}
          onCommit={handleCommit as (v: [number, number]) => void}
        />
      );
    case "select":
      return (
        <SelectRenderer
          param={param}
          value={draft as number}
          disabled={disabled}
          onCommit={handleCommit as (v: number) => void}
        />
      );
    case "toggle":
      return (
        <ToggleRenderer
          param={param}
          value={draft as boolean}
          disabled={disabled}
          onCommit={handleCommit as (v: boolean) => void}
        />
      );
    case "color":
      return (
        <ColorRenderer
          param={param}
          value={draft as string}
          disabled={disabled}
          onChange={handleChange as (v: string) => void}
          onCommit={handleCommit as (v: string) => void}
        />
      );
    case "multi-color":
      return (
        <MultiColorRenderer
          param={param}
          value={draft as string[]}
          disabled={disabled}
          onChange={handleChange as (v: string[]) => void}
          onCommit={handleCommit as (v: string[]) => void}
        />
      );
    default:
      console.warn(`No renderer found for param type: ${(param as EffectParam).type}`);
      return null;
  }
}
