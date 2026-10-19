export interface MediaSource {
  id: string;
  providerId: string;
  kind: string;
  location?: string;
  identifiers?: Readonly<Record<string, string>>;
}

export interface MediaManifestItem {
  id: string;
  kind: string;
  title?: string;
  durationSeconds?: number;
  trackNumber?: number;
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MediaManifest {
  mediaKind: string;
  items: readonly MediaManifestItem[];
  identifiers?: Readonly<Record<string, string>>;
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MediaCandidate {
  providerId: string;
  sourceId: string;
  mediaKind: string;
  label: string;
  fingerprint?: string;
  manifest: MediaManifest;
}

export interface MediaArtifact {
  id: string;
  kind: string;
  path: string;
  mediaType?: string;
  trackNumber?: number;
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MediaAcquisitionResult {
  source: MediaSource;
  artifacts: readonly MediaArtifact[];
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
}
