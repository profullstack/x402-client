/**
 * Ask for JSON, whatever the caller was asking for.
 *
 * A gateway answers a 402 with its HTML sales page when the request accepts
 * text/html, and with the JSON offer otherwise. When an adapter has to go
 * back for the offer it must replace the caller's Accept, not add to it:
 * header names are case-insensitive, `{ Accept: 'text/html', accept:
 * 'application/json' }` becomes one header with both values, and the
 * gateway sees the text/html and serves the page again.
 *
 * @param {Record<string, string>|null|undefined} headers
 * @returns {Record<string, string>}
 */
export function acceptingJson(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== 'accept' && value !== undefined && value !== null) out[name] = String(value);
  }
  out.accept = 'application/json';
  return out;
}
