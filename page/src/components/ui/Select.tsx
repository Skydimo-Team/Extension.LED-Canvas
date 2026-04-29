import {
  Box,
  HStack,
  Portal,
  Select as ChakraSelect,
  Stack,
  Text,
  createListCollection,
} from "@chakra-ui/react";
import { useId, useMemo, type ReactNode } from "react";

export interface SelectOption<T extends string | number = string> {
  value: T;
  label: string;
  /** Optional rich label renderer (e.g. icon + text). Falls back to `label`. */
  labelNode?: ReactNode;
  description?: ReactNode;
}

export interface SelectProps<T extends string | number = string> {
  /** Currently selected value */
  value: T;
  /** Options list */
  options: SelectOption<T>[];
  /** Left label */
  label?: ReactNode;
  /** Right auxiliary text */
  valueText?: ReactNode;
  /** Triggered on value change */
  onChange?: (value: T) => void;
  /** Whether disabled */
  disabled?: boolean;
  /** placeholder */
  placeholder?: string;
  /** Whether to render the popup in a Portal. Disable when used inside Dialog/Popover. */
  portalled?: boolean;
}

export function Select<T extends string | number = string>({
  value,
  options,
  label,
  valueText,
  onChange,
  disabled = false,
  placeholder = "Select...",
  portalled = true,
}: SelectProps<T>) {
  const contentId = useId();
  const collection = useMemo(
    () =>
      createListCollection({
        items: options.map((opt) => ({
          value: String(opt.value),
          label: opt.label,
          labelNode: opt.labelNode,
          description: opt.description,
        })),
      }),
    [options],
  );

  const handleValueChange = (details: { value: string[] }) => {
    if (!details.value?.length) return;

    const rawValue = details.value[0];
    // Convert back to original type
    const typedValue = (typeof value === "number" ? Number(rawValue) : rawValue) as T;
    onChange?.(typedValue);
  };

  const selectContent = (
    <ChakraSelect.Positioner>
      <ChakraSelect.Content
        id={contentId}
        maxH="var(--available-height)"
        overflowY="auto"
        p="1"
        bg="bg.panel"
        border="1px solid"
        borderColor="border"
        borderRadius="var(--radius-m)"
        boxShadow="0 8px 24px rgba(0, 0, 0, 0.3)"
        zIndex="popover"
        css={{
          // Gaussian blur effect
          backdropFilter: "var(--select-backdrop-blur)",
          // Hide native scrollbar (still keep scroll ability: mouse wheel/trackpad/touch)
          scrollbarWidth: "none",
          msOverflowStyle: "none",
          "&::-webkit-scrollbar": {
            display: "none",
          },
        }}
      >
        {collection.items.map((item) => (
          <ChakraSelect.Item
            key={item.value}
            item={item}
            px="3"
            py="2"
            borderRadius="var(--radius-s)"
            cursor="pointer"
            fontSize="14px"
            color="fg"
            _highlighted={{ bg: "var(--bg-card-hover)" }}
            css={{
              "&[data-state='checked']": {
                color: "var(--accent-color)",
              },
            }}
          >
            {item.description ? (
              <Stack gap="0">
                <ChakraSelect.ItemText>
                  {(item as { labelNode?: ReactNode }).labelNode ?? item.label}
                </ChakraSelect.ItemText>
                <Text fontSize="xs" color="fg.muted" opacity={0.85} lineHeight="1.2">
                  {item.description}
                </Text>
              </Stack>
            ) : (
              <ChakraSelect.ItemText>
                {(item as { labelNode?: ReactNode }).labelNode ?? item.label}
              </ChakraSelect.ItemText>
            )}
            <ChakraSelect.ItemIndicator css={{ color: "var(--accent-color)" }} />
          </ChakraSelect.Item>
        ))}
      </ChakraSelect.Content>
    </ChakraSelect.Positioner>
  );

  return (
    <ChakraSelect.Root
      collection={collection}
      value={[String(value)]}
      onValueChange={handleValueChange}
      disabled={disabled}
      width="full"
      positioning={{ sameWidth: true }}
      ids={{ content: contentId }}
      size="sm"
      variant="outline"
    >
      <Box width="100%">
        {(label || valueText) && (
          <HStack justify="space-between" align="center" mb="2">
            {label && (
              <ChakraSelect.Label fontSize="sm" fontWeight="500" color="fg" lineHeight="1.2">
                {label}
              </ChakraSelect.Label>
            )}
            {valueText && (
              <Text fontSize="sm" color="fg.muted" opacity={0.7} lineHeight="1.2">
                {valueText}
              </Text>
            )}
          </HStack>
        )}

        <ChakraSelect.HiddenSelect />

        <ChakraSelect.Control width="full">
          <ChakraSelect.Trigger
            width="full"
            px="3"
            py="2"
            gap="2"
            justifyContent="space-between"
            border="1px solid"
            borderColor="border"
            borderRadius="var(--radius-m)"
            bg="bg.muted"
            color="fg"
            fontSize="14px"
            _hover={{ borderColor: "fg.muted" }}
            _focusVisible={{
              outline: "none",
              borderColor: "accent.solid",
              boxShadow:
                "0 0 0 2px color-mix(in srgb, var(--accent-color) 20%, transparent)",
            }}
          >
            <ChakraSelect.ValueText placeholder={placeholder} />
          </ChakraSelect.Trigger>
          <ChakraSelect.IndicatorGroup>
            <ChakraSelect.Indicator />
          </ChakraSelect.IndicatorGroup>
        </ChakraSelect.Control>
      </Box>

      {portalled ? <Portal>{selectContent}</Portal> : selectContent}
    </ChakraSelect.Root>
  );
}
