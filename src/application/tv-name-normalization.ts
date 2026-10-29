export interface DiscStructureHints {
  seasonNumber?: number;
  discNumber?: number;
  discCount?: number;
}

export interface NormalizedDiscName {
  raw: string;
  normalized: string;
  variants: string[];
  structure: DiscStructureHints;
}

// Names written by disc mastering tools that carry no series information.
const genericNamePattern =
  /^(?:dvd(?:\s*video)?|dvd\s*volume|dvdvolume|video\s*ts|video|disc|disk|untitled|unknown|no\s*name|volume|title|tv|series|movie|cdrom|cd\s*rom|data)$/i;

export function parseDiscStructureHints(value: string): DiscStructureHints {
  const text = value.replace(/[_.]+/g, " ");
  const seasonDisc = text.match(/\b(?:seasons?|s)[\s-]*(\d{1,2})[\s-]*(?:disc|disk|d)[\s-]*(\d{1,2})\b/i);
  const season = seasonDisc ?? text.match(/\bseasons?[\s-]*(\d+)\b/i) ??
    text.match(/\bs(\d{1,2})(?:[\s-]*d\d{1,2})?\b/i);
  const disc = seasonDisc ? [seasonDisc[0], seasonDisc[2]] :
    text.match(/\b(?:disc|disk|dvd)[\s-]*(\d+)\b/i) ?? text.match(/\bd(\d{1,2})\b/i);
  const count = text.match(/\b(?:of|\/)\s*(\d+)\s*(?:discs?|disks?)\b/i) ??
    text.match(/\b(?:disc|disk)[\s-]*\d+\s*(?:of|\/)\s*(\d+)\b/i);
  return {
    ...(season?.[1] === undefined ? {} : { seasonNumber: Number(season[1]) }),
    ...(disc?.[1] === undefined ? {} : { discNumber: Number(disc[1]) }),
    ...(count?.[1] === undefined ? {} : { discCount: Number(count[1]) })
  };
}

function titleCase(value: string): string {
  return value.split(" ").map((word) => {
    const lower = word.toLocaleLowerCase();
    const hasMixedCase = word !== lower && word !== word.toLocaleUpperCase();
    if (!word || hasMixedCase) return word;
    return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
  }).join(" ");
}

function separateWords(value: string): string {
  const trimmed = value.normalize("NFKC").trim();
  // Only split CamelCase when the name is a single token such as "FreshOffTheBoat".
  const spaced = /^[\p{L}\p{N}]+$/u.test(trimmed) ? trimmed.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2") : trimmed;
  return spaced
    .replace(/[_\-–—.]+/g, " ")
    .replace(/[^\p{L}\p{N}'&!?:,() ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMarkers(value: string): string {
  return value
    .replace(/\b(?:the\s+)?complete\s+(?:series|season)s?\b/gi, " ")
    .replace(/\b(?:season|s)\s*\d{1,2}\s*(?:disc|disk|d)\s*\d{1,2}\b/gi, " ")
    .replace(/\b(?:season|series|seasons)\s*\d+\b/gi, " ")
    .replace(/\bs\d{1,2}\s*e\d{1,3}\b/gi, " ")
    .replace(/\bs\d{1,2}(?:\s*d\d{1,2})?\b/gi, " ")
    .replace(/\b(?:disc|disk|dvd|cd)\s*\d+(?:\s*(?:of|\/)\s*\d+)?\b/gi, " ")
    .replace(/\bd\d{1,2}\b/gi, " ")
    .replace(/\b(?:volume|vol)\s*\d+\b/gi, " ")
    .replace(/\b(?:season|series|disc|disk)\s*$/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Produces a metadata-search friendly series name from a raw disc or volume name. */
export function normalizeDiscName(raw: string | null | undefined): string {
  if (!raw) return "";
  const stripped = stripMarkers(separateWords(raw));
  if (!stripped || genericNamePattern.test(stripped)) return "";
  if (!/\p{L}/u.test(stripped)) return "";
  return titleCase(stripped);
}

/**
 * Builds ordered search variants: the cleaned name first, then progressively looser
 * alternatives (no leading article, no year/parenthetical, no subtitle).
 */
export function searchVariants(raw: string | null | undefined): string[] {
  const base = normalizeDiscName(raw);
  if (!base) return [];
  const variants = [base];
  const withoutYear = base.replace(/\s*\((?:19|20)\d{2}\)\s*/g, " ").replace(/\s+(?:19|20)\d{2}$/g, "").replace(/\s+/g, " ").trim();
  variants.push(withoutYear);
  variants.push(withoutYear.replace(/^(?:the|a|an)\s+/i, ""));
  const beforeColon = withoutYear.split(/\s*[:]\s*/)[0] ?? "";
  variants.push(beforeColon);
  const withoutPunctuation = withoutYear.replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
  variants.push(withoutPunctuation);
  const unique = new Map<string, string>();
  for (const variant of variants) {
    const trimmed = variant.trim();
    if (trimmed.length >= 2 && !unique.has(trimmed.toLocaleLowerCase())) unique.set(trimmed.toLocaleLowerCase(), trimmed);
  }
  return [...unique.values()];
}

export function describeNameSources(names: ReadonlyArray<string | null | undefined>): NormalizedDiscName[] {
  return names.map((raw) => ({
    raw: raw ?? "",
    normalized: normalizeDiscName(raw),
    variants: searchVariants(raw),
    structure: parseDiscStructureHints(raw ?? "")
  }));
}
