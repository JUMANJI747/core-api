'use strict';

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fetchWithTimeout };
