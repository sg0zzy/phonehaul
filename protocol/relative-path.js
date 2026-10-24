export function relativePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  )
    throw new Error('Invalid relative path');
  const parts = value.split('/');
  // Control characters are deliberately rejected in portable relative paths.
  // eslint-disable-next-line no-control-regex
  if (parts.some((p) => !p || p === '.' || p === '..' || /[\x00-\x1f\x7f]/.test(p)))
    throw new Error('Invalid relative path');
  return parts.join('/');
}
