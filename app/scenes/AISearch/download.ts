/**
 * Saves text as a Markdown file through a temporary link.
 *
 * @param markdown the file content.
 * @param filename the suggested file name.
 */
export function downloadMarkdown(markdown: string, filename: string) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
