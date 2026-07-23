const { JSONPath } = require('jsonpath-plus');

export type SseDisplayItem = {
    text: string;
    merge: boolean;
};

export type SseQueryResult = {
    items: SseDisplayItem[];
    messageCount: number;
    matchCount: number;
};

type SseMessage = {
    value: any;
    isJson: boolean;
};

export class SseMessageProcessor {
    private readonly messages: SseMessage[] = [];
    private path = '$';
    private matchCount = 0;

    public get currentPath(): string {
        return this.path;
    }

    public get messageCount(): number {
        return this.messages.length;
    }

    public get currentMatchCount(): number {
        return this.matchCount;
    }

    public appendEvent(event: string): SseQueryResult | undefined {
        const message = this.parseEvent(event);
        if (!message) {
            return undefined;
        }

        this.messages.push(message);
        const items = this.evaluate([message], this.path);
        this.matchCount += items.length;
        return {
            items,
            messageCount: this.messages.length,
            matchCount: this.matchCount
        };
    }

    public setPath(path: string): SseQueryResult {
        const normalizedPath = path.trim() || '$';
        const items = this.evaluate(this.messages, normalizedPath);
        this.path = normalizedPath;
        this.matchCount = items.length;
        return {
            items,
            messageCount: this.messages.length,
            matchCount: this.matchCount
        };
    }

    public snapshot(): SseQueryResult {
        const items = this.evaluate(this.messages, this.path);
        this.matchCount = items.length;
        return {
            items,
            messageCount: this.messages.length,
            matchCount: this.matchCount
        };
    }

    private parseEvent(event: string): SseMessage | undefined {
        const dataLines = event
            .replace(/^\uFEFF/, '')
            .split(/\r\n|\r|\n/)
            .filter(line => line === 'data' || line.startsWith('data:'))
            .map(line => {
                const value = line === 'data' ? '' : line.slice(5);
                return value.startsWith(' ') ? value.slice(1) : value;
            });
        if (dataLines.length === 0) {
            return undefined;
        }

        const data = dataLines.join('\n');
        try {
            return { value: JSON.parse(data), isJson: true };
        } catch {
            return { value: data, isJson: false };
        }
    }

    private evaluate(messages: SseMessage[], path: string): SseDisplayItem[] {
        const items: SseDisplayItem[] = [];
        for (const message of messages) {
            const matches = JSONPath({ path, json: message.value, wrap: true });
            for (const match of matches) {
                const merge = message.isJson && typeof match === 'string';
                const text = typeof match === 'string'
                    ? match
                    : typeof match === 'object'
                        ? JSON.stringify(match, null, 2)
                        : String(match);
                items.push({ text, merge });
            }
        }
        return items;
    }
}
