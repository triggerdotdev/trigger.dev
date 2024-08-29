// When proxying long-polling requests, content-encoding & content-length are added
// erroneously (saying the body is gzipped when it's not) so we'll just remove
// them to avoid content decoding errors in the browser.
//
// Similar-ish problem to https://github.com/wintercg/fetch/issues/23
export async function longPollingFetch(url: string, options?: RequestInit) {
  let response = await fetch(url, options);
  if (response.headers.get(`content-encoding`)) {
    const headers = new Headers(response.headers);
    headers.delete(`content-encoding`);
    headers.delete(`content-length`);
    response = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
}
