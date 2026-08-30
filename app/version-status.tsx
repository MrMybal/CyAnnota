'use client';

import { useEffect, useState } from 'react';
import packageMetadata from '../package.json';
import { AppLocale, translate } from './i18n';

const RELEASES_URL = 'https://github.com/MrMybal/CyAnnota/releases';
const LATEST_RELEASE_API = 'https://api.github.com/repos/MrMybal/CyAnnota/releases/latest';
const UPDATE_CACHE_KEY = 'cyannota.latest-release.v1';
const UPDATE_CACHE_DURATION = 6 * 60 * 60 * 1000;

export const APP_VERSION = packageMetadata.version;

type LatestRelease = {
  tag: string;
  checkedAt: number;
};

function versionParts(version: string) {
  return version
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate: string, current: string) {
  const candidateParts = versionParts(candidate);
  const currentParts = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    const candidatePart = candidateParts[index] || 0;
    const currentPart = currentParts[index] || 0;
    if (candidatePart > currentPart) return true;
    if (candidatePart < currentPart) return false;
  }
  return false;
}

function readCachedRelease() {
  try {
    const value = window.localStorage.getItem(UPDATE_CACHE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<LatestRelease>;
    if (typeof parsed.tag !== 'string' || typeof parsed.checkedAt !== 'number') return null;
    return parsed as LatestRelease;
  } catch {
    return null;
  }
}

export default function VersionStatus({ locale }: { locale: AppLocale }) {
  const [latestRelease, setLatestRelease] = useState<LatestRelease | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function checkLatestRelease() {
      const cached = readCachedRelease();
      if (cached) setLatestRelease(cached);
      if (cached && Date.now() - cached.checkedAt < UPDATE_CACHE_DURATION) return;

      try {
        const response = await fetch(LATEST_RELEASE_API, {
          cache: 'no-store',
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!response.ok) return;
        const data = await response.json() as { tag_name?: unknown };
        const tag = typeof data.tag_name === 'string' ? data.tag_name.trim() : '';
        if (!tag || cancelled) return;
        const next = { tag, checkedAt: Date.now() };
        window.localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify(next));
        setLatestRelease(next);
      } catch {
        // CyAnnota remains fully usable offline; update checks are optional.
      }
    }

    checkLatestRelease().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const updateAvailable = latestRelease && isNewerVersion(latestRelease.tag, APP_VERSION);
  const releaseUrl = updateAvailable
    ? RELEASES_URL + '/tag/' + encodeURIComponent(latestRelease.tag)
    : RELEASES_URL;

  return (
    <span className="brand-version-row" aria-live="polite">
      <span className="brand-version">v{APP_VERSION}</span>
      {updateAvailable && (
        <a
          className="update-warning"
          href={releaseUrl}
          target="_blank"
          rel="noreferrer"
          title={translate(locale, 'Open the latest GitHub release', 'Ouvrir la derni\u00e8re release GitHub')}
        >
          <span aria-hidden="true">&#9679;</span>
          {translate(locale, 'Update ', 'Mise \u00e0 jour ')}{latestRelease.tag}{translate(locale, ' available', ' disponible')}
        </a>
      )}
    </span>
  );
}
