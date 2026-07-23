import * as fs from 'fs-extra';
import * as iconv from 'iconv-lite';
import * as path from 'path';
import { CookieJar, Store } from 'tough-cookie';
import * as url from 'url';
import { Uri, window } from 'vscode';
import { RequestHeaders, ResponseHeaders } from '../models/base';
import { IRestClientSettings, SystemSettings } from '../models/configurationSettings';
import { HttpRequest } from '../models/httpRequest';
import { HttpResponse } from '../models/httpResponse';
import { awsCognito } from './auth/awsCognito';
import { awsSignature } from './auth/awsSignature';
import { digest } from './auth/digest';
import { MimeUtility } from './mimeUtility';
import { getHeader, removeHeader } from './misc';
import { SseStreamParser } from './sseStreamParser';
import { convertBufferToStream, convertStreamToBuffer } from './streamUtility';
import { UserDataManager } from './userDataManager';
import { getCurrentHttpFileName, getWorkspaceRootPath } from './workspaceUtility';

import { CancelableRequest, Headers, Method, OptionsOfBufferResponseBody, Response } from 'got';
import got = require('got');

const encodeUrl = require('encodeurl');
const CookieFileStore = require('tough-cookie-file-store').FileCookieStore;

type Certificate = {
    cert?: Buffer;
    key?: Buffer;
    pfx?: Buffer;
    passphrase?: string;
};

export type SseResponseHandler = {
    onStart(response: HttpResponse): void;
    onEvent(response: HttpResponse, event: string): void;
};

export class HttpClient {
    private cookieStore: Store;

    public constructor() {
        const cookieFilePath = UserDataManager.cookieFilePath;
        this.cookieStore = new CookieFileStore(cookieFilePath) as Store;
    }

    public async send(
        httpRequest: HttpRequest,
        settings?: IRestClientSettings,
        sseHandler?: SseResponseHandler): Promise<HttpResponse> {
        settings = settings || SystemSettings.Instance;

        const options = await this.prepareOptions(httpRequest, settings);

        let bodySize = 0;
        let headersSize = 0;
        let sseResponse: HttpResponse | undefined;
        const requestUrl = encodeUrl(httpRequest.url);
        const request: CancelableRequest<Response<Buffer>> = got.default(requestUrl, options);
        httpRequest.setUnderlyingRequest(request);
        (request as any).on('response', (res: Response<Buffer>) => {
            if (res.rawHeaders) {
                headersSize += res.rawHeaders.map(h => h.length).reduce((a, b) => a + b, 0);
                headersSize += (res.rawHeaders.length) / 2;
            }

            const responseHeaders = HttpClient.normalizeHeaderNames(res.headers, res.rawHeaders);
            if (sseHandler && HttpClient.isEventStream(responseHeaders)) {
                sseResponse = this.createHttpResponse(
                    res,
                    responseHeaders,
                    '',
                    0,
                    headersSize,
                    Buffer.alloc(0),
                    options,
                    httpRequest,
                    requestUrl);
                sseHandler.onStart(sseResponse);

                const parser = new SseStreamParser(event => {
                    sseResponse!.appendBody(event);
                    sseHandler.onEvent(sseResponse!, event);
                });
                res.on('data', chunk => parser.push(chunk));
                res.on('end', () => parser.end());
            } else {
                res.on('data', chunk => {
                    bodySize += chunk.length;
                });
            }
        });

        const response = await request;

        if (sseResponse) {
            sseResponse.timingPhases = response.timings.phases;
            return sseResponse;
        }

        const contentType = response.headers['content-type'];
        let encoding: string | undefined;
        if (contentType) {
            encoding = MimeUtility.parse(contentType).charset;
        }

        if (!encoding) {
            encoding = "utf8";
        }

        const bodyBuffer = response.body;
        let bodyString = iconv.encodingExists(encoding) ? iconv.decode(bodyBuffer, encoding) : bodyBuffer.toString();

        if (settings.decodeEscapedUnicodeCharacters) {
            bodyString = this.decodeEscapedUnicodeCharacters(bodyString);
        }

        const responseHeaders: ResponseHeaders = HttpClient.normalizeHeaderNames(response.headers, response.rawHeaders);
        return this.createHttpResponse(
            response,
            responseHeaders,
            bodyString,
            bodySize,
            headersSize,
            bodyBuffer,
            options,
            httpRequest,
            requestUrl);
    }

    public async clearCookies() {
        await fs.remove(UserDataManager.cookieFilePath);
        this.cookieStore = new CookieFileStore(UserDataManager.cookieFilePath) as Store;
    }

    private async prepareOptions(httpRequest: HttpRequest, settings: IRestClientSettings): Promise<OptionsOfBufferResponseBody> {
        const originalRequestBody = httpRequest.body;
        let requestBody: string | Buffer | undefined;
        if (originalRequestBody) {
            if (typeof originalRequestBody !== 'string') {
                requestBody = await convertStreamToBuffer(originalRequestBody);
            } else {
                requestBody = originalRequestBody;
            }
        }

        // Fix #682 Do not touch original headers in httpRequest, which may be used for retry later
        // Simply do a shadow copy here
        const clonedHeaders = Object.assign({}, httpRequest.headers);

        const options: OptionsOfBufferResponseBody = {
            headers: clonedHeaders as any as Headers,
            method: httpRequest.method as any as Method,
            body: requestBody,
            responseType: 'buffer',
            decompress: true,
            followRedirect: settings.followRedirect,
            throwHttpErrors: false,
            retry: 0,
            hooks: {
                afterResponse: [],
                beforeRequest: [],
            },
            https: {
                rejectUnauthorized: false
            }
        };

        if (settings.timeoutInMilliseconds > 0) {
            options.timeout = settings.timeoutInMilliseconds;
        }

        if (settings.rememberCookiesForSubsequentRequests) {
            options.cookieJar = new CookieJar(this.cookieStore);
        }

        // TODO: refactor auth
        const authorization = getHeader(options.headers!, 'Authorization') as string | undefined;
        if (authorization) {
            const [scheme, user, ...args] = authorization.split(/\s+/);
            const normalizedScheme = scheme.toLowerCase();
            if (args.length > 0) {
                const pass = args.join(' ');
                if (normalizedScheme === 'basic') {
                    removeHeader(options.headers!, 'Authorization');
                    options.username = user;
                    options.password = pass;
                } else if (normalizedScheme === 'digest') {
                    removeHeader(options.headers!, 'Authorization');
                    options.hooks!.afterResponse!.push(digest(user, pass));
                } else if (normalizedScheme === 'aws') {
                    removeHeader(options.headers!, 'Authorization');
                    options.hooks!.beforeRequest!.push(awsSignature(authorization));
                } else if (normalizedScheme === 'cognito') {
                    removeHeader(options.headers!, 'Authorization');
                   options.hooks!.beforeRequest!.push(await awsCognito(authorization));
                }
            } else if (normalizedScheme === 'basic' && user.includes(':')) {
                removeHeader(options.headers!, 'Authorization');
                const [username, password] = user.split(':');
                options.username = username;
                options.password = password;
            }
        }

        // set certificate
        const certificate = this.getRequestCertificate(httpRequest.url, settings);
        Object.assign(options, certificate);

        // set proxy
        if (settings.proxy && !HttpClient.ignoreProxy(httpRequest.url, settings.excludeHostsForProxy)) {
            const proxyEndpoint = url.parse(settings.proxy);
            if (/^https?:$/.test(proxyEndpoint.protocol || '')) {
                const proxyOptions = {
                    host: proxyEndpoint.hostname,
                    port: Number(proxyEndpoint.port),
                    rejectUnauthorized: settings.proxyStrictSSL
                };

                const ctor = (httpRequest.url.startsWith('http:')
                    ? await import('http-proxy-agent')
                    : await import('https-proxy-agent')).default;

                options.agent = new ctor(proxyOptions);
            }
        }

        return options;
    }

    private decodeEscapedUnicodeCharacters(body: string): string {
        return body.replace(/\\u([0-9a-fA-F]{4})/gi, (_, g) => {
            const char = String.fromCharCode(parseInt(g, 16));
            return char === '"' ? '\\"' : char;
        });
    }

    private createHttpResponse(
        response: Response<Buffer>,
        responseHeaders: ResponseHeaders,
        body: string,
        bodySize: number,
        headersSize: number,
        bodyBuffer: Buffer,
        options: OptionsOfBufferResponseBody,
        httpRequest: HttpRequest,
        requestUrl: string): HttpResponse {
        const requestBody = options.body;
        return new HttpResponse(
            response.statusCode,
            response.statusMessage!,
            response.httpVersion,
            responseHeaders,
            body,
            bodySize,
            headersSize,
            bodyBuffer,
            response.timings.start,
            response.timings.phases,
            new HttpRequest(
                options.method!,
                requestUrl,
                HttpClient.normalizeHeaderNames(
                    (response as any).request.options.headers as RequestHeaders,
                    Object.keys(httpRequest.headers)),
                Buffer.isBuffer(requestBody) ? convertBufferToStream(requestBody) : requestBody,
                httpRequest.rawBody,
                httpRequest.name
            ));
    }

    private getRequestCertificate(requestUrl: string, settings: IRestClientSettings): Certificate | null {
        const host = url.parse(requestUrl).host;
        if (!host || !(host in settings.hostCertificates)) {
            return null;
        }

        const { cert: certPath, key: keyPath, pfx: pfxPath, passphrase } = settings.hostCertificates[host];
        const cert = this.resolveCertificate(certPath);
        const key = this.resolveCertificate(keyPath);
        const pfx = this.resolveCertificate(pfxPath);
        return { cert, key, pfx, passphrase };
    }

    private static ignoreProxy(requestUrl: string, excludeHostsForProxy: string[]): Boolean {
        if (!excludeHostsForProxy || excludeHostsForProxy.length === 0) {
            return false;
        }

        const resolvedUrl = url.parse(requestUrl);
        const hostName = resolvedUrl.hostname?.toLowerCase();
        const port = resolvedUrl.port;
        const excludeHostsProxyList = Array.from(new Set(excludeHostsForProxy.map(eh => eh.toLowerCase())));

        for (const eh of excludeHostsProxyList) {
            const urlParts = eh.split(":");
            if (!port) {
                // if no port specified in request url, host name must exactly match
                if (urlParts.length === 1 && urlParts[0] === hostName) {
                    return true;
                }
            } else {
                // if port specified, match host without port or hostname:port exactly match
                const [ph, pp] = urlParts;
                if (ph === hostName && (!pp || pp === port)) {
                    return true;
                }
            }
        }

        return false;
    }

    private resolveCertificate(absoluteOrRelativePath: string | undefined): Buffer | undefined {
        if (absoluteOrRelativePath === undefined) {
            return undefined;
        }

        if (path.isAbsolute(absoluteOrRelativePath)) {
            if (!fs.existsSync(absoluteOrRelativePath)) {
                window.showWarningMessage(`Certificate path ${absoluteOrRelativePath} doesn't exist, please make sure it exists.`);
                return undefined;
            } else {
                return fs.readFileSync(absoluteOrRelativePath);
            }
        }

        // the path should be relative path
        const rootPath = getWorkspaceRootPath();
        let absolutePath = '';
        if (rootPath) {
            absolutePath = path.join(Uri.parse(rootPath).fsPath, absoluteOrRelativePath);
            if (fs.existsSync(absolutePath)) {
                return fs.readFileSync(absolutePath);
            } else {
                window.showWarningMessage(`Certificate path ${absoluteOrRelativePath} doesn't exist, please make sure it exists.`);
                return undefined;
            }
        }

        const currentFilePath = getCurrentHttpFileName();
        if (!currentFilePath) {
            return undefined;
        }

        absolutePath = path.join(path.dirname(currentFilePath), absoluteOrRelativePath);
        if (fs.existsSync(absolutePath)) {
            return fs.readFileSync(absolutePath);
        } else {
            window.showWarningMessage(`Certificate path ${absoluteOrRelativePath} doesn't exist, please make sure it exists.`);
            return undefined;
        }
    }

    private static normalizeHeaderNames<T extends RequestHeaders | ResponseHeaders>(headers: T, rawHeaders: string[]): T {
        const headersDic: { [key: string]: string } = rawHeaders.reduce(
            (prev, cur) => {
                if (!(cur.toLowerCase() in prev)) {
                    prev[cur.toLowerCase()] = cur;
                }
                return prev;
            }, {});
        const adjustedResponseHeaders = {} as RequestHeaders | ResponseHeaders;
        for (const header in headers) {
            const adjustedHeaderName = headersDic[header] || header;
            adjustedResponseHeaders[adjustedHeaderName] = headers[header];
        }

        return adjustedResponseHeaders as T;
    }

    private static isEventStream(headers: ResponseHeaders): boolean {
        const contentType = getHeader(headers, 'Content-Type');
        return contentType?.toString().split(';', 1)[0].trim().toLowerCase() === 'text/event-stream';
    }
}
