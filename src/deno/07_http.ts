import { HttpClient, type HttpClientOptions } from '../webapi/fetch/http-client';

export { HttpClient };
export type { HttpClientOptions };

function createHttpClient(options: HttpClientOptions = {}): HttpClient {
    return new HttpClient(options);
}

Object.assign(Deno, {
    createHttpClient,
    HttpClient
});
