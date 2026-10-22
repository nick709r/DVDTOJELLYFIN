# Library Metadata and Organization

AutoDisc imports metadata only for publishing workflows currently supported by
the application: TMDB-identified DVD movies, TV DVDs with explicitly saved
series/episode mappings, and MusicBrainz-identified or manually described
audio CDs. Blu-ray, audiobooks, concerts, music videos, and other media types
do not have publishing workflows in this release.

## Settings and behavior

Settings → **Metadata, artwork & organization** controls automatic import,
per-category metadata selection, artwork classes, NFO generation, naming
templates, and a compatibility profile. Metadata import options default on.
Online lookups remain governed by their existing provider settings and remain
off by default unless the operator enables and configures them. A local/manual
identification can still be written to NFO without making an online request.

Provider capabilities:

| Workflow/provider | Data imported by AutoDisc |
|---|---|
| Movie / TMDB | Title, year, overview, genres, ratings, cast, poster, backdrop, logo, and fanart when the provider returns them |
| TV DVD / TVDB | Series title, year, overview, and provider image when returned; mapped episode titles and optional user-entered air dates/notes |
| TV DVD / TMDB or IMDb-through-TMDB | Series details, genres, rating, cast, poster, backdrop, logo, and fanart when returned; mapped episode titles |
| Audio CD / MusicBrainz | Artist, album, year, track titles, and Cover Art Archive front cover when a release ID is available |

Providers do not currently supply every artwork type or every metadata field.
Season artwork, episode images, banners, logos, ratings, cast, and other
options are applied only when a supported provider supplies the corresponding
data. AutoDisc does not fabricate missing provider data. MusicBrainz cover
artwork is stored as `folder.jpg`; other image files use conventional
poster/backdrop/fanart/logo/banner names and preserve the provider's actual
image format.

Automatic metadata/artwork import can be disabled independently of online
lookup. Metadata request or artwork download errors are logged as warnings and
do not cancel a successful media conversion. Artwork downloads use HTTPS,
provider host allowlists, redirect validation, a 12-second request timeout,
and a 15 MB size limit. Existing image and NFO files are never overwritten.

## NFO compatibility

NFO generation is optional. The Jellyfin, Emby, and Kodi selections generate
the shared Kodi-style XML NFO format consumed by these media managers where
their readers support the corresponding tags. AutoDisc writes movie, series,
season, episode, artist, and album NFO files next to the relevant media. NFO
output is atomic and does not replace existing files. Cast and ratings are
omitted when their respective settings are off.

## Folder organization

The built-in Jellyfin, Sonarr, Radarr, Lidarr, and Kodi profiles use common
compatible structures for the media types AutoDisc can publish:

```text
Movies/Movie Title (Year)/Movie Title (Year).mkv
TV/Series Name (Year)/Season 01/Series Name - S01E01 - Episode Title.mkv
Music/Artist/Album (Year)/01 - Track Title.flac
```

The `Custom` profile uses the saved templates; the built-in profiles use their
standard naming patterns. Templates can be edited when `Custom` is selected
and must produce a single safe path component. Supported tokens are:

- `{Series Name}`, `{Movie Title}`, `{Year}`, `{Season Number:00}`,
  `{Season}`, `{Episode:00}`, `{Episode Title}`, `{Artist}`, `{Album}`.

Episode tracks assigned to multiple episodes retain the existing multi-episode
filename convention (for example, `S01E01-02`). Existing collision checks and
no-overwrite behavior continue to apply.

## Persistence and API

Migration 20 adds `imported_metadata_json` and `artwork_references_json` to
`disc_recovery`. Existing records receive empty metadata and artwork values; classification
decisions, episode mappings, and older database history are unchanged.
Identified movie metadata, confirmed TV series data, and non-fallback audio-CD
metadata/provider IDs/artwork references are stored with the disc fingerprint.
Rediscovery reuses the saved result rather than repeating an online lookup.

The authenticated `GET /api/v1/settings` response includes `libraryMetadata`.
`PUT /api/v1/settings` accepts the full `libraryMetadata` object containing
these boolean fields:

```text
automaticImport, downloadSeriesMetadata, downloadEpisodeMetadata,
downloadMovieMetadata, downloadMusicMetadata, downloadCastInformation,
downloadRatings, downloadArtwork, downloadSeasonArtwork,
downloadEpisodeImages, downloadFanart, downloadLogos, downloadBackdrops,
downloadBanners, generateNfo
```

It also accepts `nfoFormat` (`jellyfin`, `kodi`, `emby`),
`libraryStructure` (`jellyfin`, `sonarr`, `radarr`, `lidarr`, `kodi`,
`custom`), and the seven `*Template` values shown in Settings. The API
validates enums and template tokens before saving.

The existing `PUT /api/v1/tv/plans/:id/recovery` and
`PUT /api/v1/discs/recovery/:fingerprint` endpoints accept optional
`importedMetadata` objects (up to 64 KB) and `artworkReferences` arrays
(maximum 20 HTTPS URLs from supported image-provider hosts). The associated
GET routes return the stored values. These fields supplement, and do not
replace, detected classification or user-entered series/episode data.

For the TV review sequence and mapping behavior, see
[TV Metadata Recovery and Manual Episode Processing](./TV-MANUAL-RECOVERY.md).
