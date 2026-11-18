import { Button } from "@/components/ui/button";

/**
 * An on/off choice shown as a button (`aria-pressed`): NULL, Default, Array, Can be NULL.
 * It is the height of a field (32 px), so it sits in a row of fields without throwing it off.
 * Give it an accessible `name` that says what it is about when several appear on one screen
 * ("NULL for note").
 */
export function ToggleButton({
  pressed,
  label,
  name,
  onClick,
}: {
  pressed: boolean;
  label: string;
  name: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={pressed}
      aria-label={name}
      onClick={onClick}
      // The dark variants are spelled out: the outline button's own dark fill would otherwise win over
      // the pressed colours and leave dark text on a dark background.
      className="px-2.5 text-xs aria-pressed:border-transparent aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90 dark:aria-pressed:bg-primary dark:aria-pressed:text-primary-foreground dark:aria-pressed:hover:bg-primary/90"
    >
      {label}
    </Button>
  );
}
