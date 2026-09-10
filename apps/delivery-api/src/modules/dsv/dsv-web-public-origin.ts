export function loadDsvWebPublicOrigin(value: string | undefined, nodeEnv = 'development'): string | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === '') return undefined;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw invalidOriginError();
  }
  const isLocalHttp = nodeEnv !== 'production'
    && url.protocol === 'http:'
    && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !isLocalHttp)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw invalidOriginError();
  }
  return url.origin;
}

function invalidOriginError(): Error {
  return new Error('CLEVER_DSV_WEB_PUBLIC_URL must be an HTTPS origin; localhost HTTP is allowed outside production');
}
