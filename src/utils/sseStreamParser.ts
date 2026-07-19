import { StringDecoder } from 'string_decoder';

export class SseStreamParser {
    private readonly decoder = new StringDecoder('utf8');
    private pending = '';

    public constructor(private readonly onEvent: (event: string) => void) {
    }

    public push(chunk: Buffer | string) {
        this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
        this.emitCompleteEvents();
    }

    public end() {
        this.pending += this.decoder.end();
        this.emitCompleteEvents();
        if (this.pending) {
            this.onEvent(this.pending);
            this.pending = '';
        }
    }

    private emitCompleteEvents() {
        let separator = this.pending.match(/\r\n\r\n|\n\n|\r\r/);
        while (separator?.index !== undefined) {
            const eventEnd = separator.index + separator[0].length;
            this.onEvent(this.pending.slice(0, eventEnd));
            this.pending = this.pending.slice(eventEnd);
            separator = this.pending.match(/\r\n\r\n|\n\n|\r\r/);
        }
    }
}
