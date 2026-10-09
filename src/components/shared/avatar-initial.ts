export function avatarInitial(name: string): string {
  // The app lib is ES2020, which does not declare Intl.Segmenter.
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locales?: undefined,
        options?: { granularity: "grapheme" },
      ) => { segment(input: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;

  if (typeof Segmenter === "function") {
    for (const { segment } of new Segmenter(undefined, { granularity: "grapheme" }).segment(name)) {
      return segment;
    }
    return "";
  }

  const point = name.codePointAt(0);
  return point === undefined ? "" : String.fromCodePoint(point);
}
