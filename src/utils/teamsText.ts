/**
 * Teams renders bot text as Markdown (MessageFactory.text sets no textFormat,
 * so the Bot Framework default `markdown` applies). Two consequences that make
 * messages look wrong compared to what the author typed:
 *
 *   1. A single "\n" is not a line break in Markdown — the next line is glued
 *      onto the previous one. "Hey,\nKeine Leerzeile" arrives as one line.
 *   2. A blank line becomes a paragraph break, which Teams renders without a
 *      visible gap. Whether the author left one blank line or three, the
 *      result looks identical.
 *
 * This restores both, preserving the number of blank lines the author wrote:
 *   - single newline  -> hard Markdown break ("  \n")
 *   - N blank lines   -> N paragraphs containing &nbsp; (a non-breaking space
 *                        survives whitespace collapsing, an empty one does not)
 *
 * A line consisting only of spaces/tabs counts as a blank line — that is what
 * the author sees in the editor.
 *
 * NOT idempotent: applying it twice grows the blank lines. Call it exactly
 * once, immediately before handing the text to MessageFactory.
 */
export function toTeamsMarkdown(text: string): string {
  if (!text) return text;

  return (
    text
      // CRLF / CR -> LF, so the patterns below only deal with "\n".
      .replace(/\r\n?/g, '\n')
      // Runs of blank lines -> the same number of visible empty paragraphs.
      // "\n\n" is one blank line, "\n\n\n" is two, and so on.
      .replace(/\n(?:[ \t]*\n)+/g, (match) => {
        const blankLines = (match.match(/\n/g) as RegExpMatchArray).length - 1;
        return '\n\n' + '&nbsp;\n\n'.repeat(blankLines);
      })
      // Remaining single newline -> hard break. Not at the very end: a trailing
      // break would add an empty line nobody asked for.
      .replace(/([^\n])[ \t]*\n(?!\n|$)/g, '$1  \n')
  );
}
