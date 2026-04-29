import { Stack, Switch as ChakraSwitch, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";

/* spring-like easing for a natural bounce feel */
const SPRING_EASE = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const SLIDE_DURATION = "0.25s";

export interface SwitchProps {
  /** Whether currently enabled */
  checked: boolean;
  /** State change handler */
  onChange?: (checked: boolean) => void;
  /** Left main label */
  label?: ReactNode;
  /** Left description (optional) */
  description?: ReactNode;
  /** Whether disabled */
  disabled?: boolean;
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: SwitchProps) {
  const hasText = label != null || description != null;

  return (
    <ChakraSwitch.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={(details) => onChange?.(details.checked)}
      display="flex"
      alignItems="center"
      justifyContent={hasText ? "space-between" : "flex-end"}
      gap="4"
      width={hasText ? "full" : "auto"}
    >
      {hasText && (
        <Stack gap="0.5" minW="0">
          {label && (
            <ChakraSwitch.Label fontSize="sm" fontWeight="medium">
              {label}
            </ChakraSwitch.Label>
          )}
          {description && (
            <Text fontSize="sm" color="fg.muted">
              {description}
            </Text>
          )}
        </Stack>
      )}

      <ChakraSwitch.HiddenInput />
      <ChakraSwitch.Control
        bg="var(--switch-control-bg)"
        _checked={{
          bg: "var(--switch-control-checked-bg)",
        }}
        transition={`background ${SLIDE_DURATION} ease`}
      >
        <ChakraSwitch.Thumb
          bg="var(--switch-thumb-bg)"
          _checked={{
            bg: "var(--switch-thumb-checked-bg)",
            transform: "rotate(180deg)",
          }}
          _active={{
            scaleX: "1.2",
          }}
          transform="rotate(0deg)"
          transition={[
            `translate ${SLIDE_DURATION} ${SPRING_EASE}`,
            `transform ${SLIDE_DURATION} ${SPRING_EASE}`,
            `scale ${SLIDE_DURATION} ${SPRING_EASE}`,
            `background ${SLIDE_DURATION} ease`,
          ].join(", ")}
        />
      </ChakraSwitch.Control>
    </ChakraSwitch.Root>
  );
}
