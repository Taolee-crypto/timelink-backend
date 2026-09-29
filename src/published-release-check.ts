/**
 * Minimal published-release check for MP3 uploads.
 *
 * This is intentionally NOT a copyright adjudicator.
 * It only checks whether title + artist match an already-released
 * recording found through the configured Spotify catalog.
 */
export type PublishedReleaseMatch = {
  matched: boolean;
  source: 'spotify' | 'none' | 'unavailable';
  title?: string;
  artist?: string;
  album?: string;
  spotify_id?: string;
  release_date?: string;
  reason?: string;
};

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, '')
    .replace(/[\s\-_·•.,!?()[\]{}]+/g, '');
}

export async function checkPublishedRelease(
  env: any,
  title: string,
  artist = '',
): Promise<PublishedReleaseMatch> {
  if (!title?.trim()) {
    return { matched: false, source: 'none', reason: 'title_missing' };
  }

  const clientId = env.SPOTIFY_CLIENT_ID;
  const clientSecret = env.SPOTIFY_CLIENT_SECRET;

  // Do not block uploads when the external catalog is not configured.
  if (!clientId || !clientSecret) {
    return { matched: false, source: 'unavailable', reason: 'spotify_not_configured' };
  }

  try {
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(clientId + ':' + clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!tokenResponse.ok) {
      return { matched: false, source: 'unavailable', reason: 'spotify_token_failed' };
    }

    const tokenData = await tokenResponse.json<any>();
    const token = tokenData.access_token;
    if (!token) {
      return { matched: false, source: 'unavailable', reason: 'spotify_token_missing' };
    }

    const q = artist.trim()
      ? `track:"${title.trim()}" artist:"${artist.trim()}"`
      : `track:"${title.trim()}"`;

    const response = await fetch(
      'https://api.spotify.com/v1/search?q=' +
        encodeURIComponent(q) +
        '&type=track&limit=10&market=KR',
      { headers: { Authorization: 'Bearer ' + token } },
    );

    if (!response.ok) {
      return { matched: false, source: 'unavailable', reason: 'spotify_search_failed' };
    }

    const data = await response.json<any>();
    const titleKey = normalize(title);
    const artistKey = normalize(artist);

    const exact = (data.tracks?.items || []).find((track: any) => {
      const trackTitle = normalize(track.name || '');
      const trackArtists = (track.artists || []).map((a: any) => normalize(a.name || ''));
      const titleMatch = trackTitle === titleKey;
      const artistMatch = !artistKey || trackArtists.some((a: string) => a === artistKey);
      return titleMatch && artistMatch;
    });

    if (!exact) {
      return { matched: false, source: 'spotify', reason: 'no_exact_published_match' };
    }

    return {
      matched: true,
      source: 'spotify',
      title: exact.name,
      artist: (exact.artists || []).map((a: any) => a.name).join(', '),
      album: exact.album?.name || '',
      spotify_id: exact.id,
      release_date: exact.album?.release_date || '',
      reason: 'exact_title_artist_match',
    };
  } catch {
    return { matched: false, source: 'unavailable', reason: 'spotify_check_error' };
  }
}
