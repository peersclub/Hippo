/**
 * Positions card view-model — pure, so it tests in node.
 *
 * The empty state must not make a claim about the ACCOUNT. An empty `rows[]`
 * can mean the trader is flat, but it can just as easily mean a venue fetch
 * failed or a multi-venue answer came back partial — and the SDK cannot tell
 * those apart. So the card draws the SERVER's empty-state text when it
 * authored one, and otherwise a neutral client string that asserts nothing
 * ("Nothing to show" — not "you have no positions").
 */

export function positionsEmptyText(emptyText: string | undefined, neutral: string): string {
  const authored = (emptyText ?? '').trim()
  return authored === '' ? neutral : authored
}
