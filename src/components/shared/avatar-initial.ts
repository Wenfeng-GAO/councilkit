export function avatarInitial(name: string): string {
  const point = name.codePointAt(0);
  return point === undefined ? "" : String.fromCodePoint(point);
}
