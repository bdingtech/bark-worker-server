const PREFIX_SEGMENT = /^[A-Za-z0-9._-]+$/;

export const normalizeUrlPrefix = (urlPrefix: string | undefined): string => {
  if (urlPrefix === undefined || urlPrefix === '' || urlPrefix === '/') {
    return '/';
  }
  if (!urlPrefix.startsWith('/')) {
    throw new Error('URL_PREFIX must start with "/"');
  }
  if (urlPrefix.endsWith('/')) {
    throw new Error('URL_PREFIX must not end with "/"');
  }

  const segments = urlPrefix.slice(1).split('/');
  if (
    segments.some(
      (segment) =>
        segment === '.' || segment === '..' || !PREFIX_SEGMENT.test(segment),
    )
  ) {
    throw new Error('URL_PREFIX contains an invalid path segment');
  }

  return urlPrefix;
};

/** Project-relative edge function file. No Node Functions output. */
export const edgeFunctionRelativePath = (
  urlPrefix: string | undefined,
): string => {
  const prefix = normalizeUrlPrefix(urlPrefix);
  if (prefix === '/') {
    return 'edge-functions/[[default]].js';
  }
  return `edge-functions${prefix}/[[default]].js`;
};
