import { Timings } from '@szmarczak/http-timer';
import { getContentType } from '../utils/misc';
import { ResponseHeaders } from './base';
import { HttpRequest } from "./httpRequest";

export class HttpResponse {
    private readonly bodyBuffers: Buffer[];

    public constructor(
        public statusCode: number,
        public statusMessage: string,
        public httpVersion: string,
        public headers: ResponseHeaders,
        public body: string,
        public bodySizeInBytes: number,
        public headersSizeInBytes: number,
        bodyBuffer: Buffer,
        public timingPhases: Timings['phases'],
        public request: HttpRequest) {
        this.bodyBuffers = [bodyBuffer];
    }

    public get contentType(): string | undefined {
        return getContentType(this.headers);
    }

    public get bodyBuffer(): Buffer {
        return this.bodyBuffers.length === 1
            ? this.bodyBuffers[0]
            : Buffer.concat(this.bodyBuffers);
    }

    public appendBody(chunk: string) {
        const buffer = Buffer.from(chunk, 'utf8');
        this.body += chunk;
        this.bodySizeInBytes += buffer.length;
        this.bodyBuffers.push(buffer);
    }
}
