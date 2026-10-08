/**
 * Identifies if a prompt comes from a machine/system hook based on prefix tags.
 * Prompts starting with `<task-notification>`, `<wake>`, or `<relay>` are classified
 * as machine-initiated, returning the machine:<tag> format.
 */
export function getMachineOrigin(prompt: string): string | undefined {
  const trimmed = prompt.trim();
  const match = trimmed.match(/^<(task-notification|wake|relay)\b/);
  if (match) {
    return `machine:${match[1]}`;
  }
  return undefined;
}
