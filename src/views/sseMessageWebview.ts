import { Event, EventEmitter, ExtensionContext, ViewColumn, WebviewPanel, window } from 'vscode';
import { HttpResponse } from '../models/httpResponse';
import { disposeAll } from '../utils/dispose';
import { SseMessageProcessor, SseQueryResult } from '../utils/sseMessageProcessor';
import { BaseWebview } from './baseWebview';

type SseRound = {
    response: HttpResponse;
    processor: SseMessageProcessor;
};

export type SseResendRequest = {
    response: HttpResponse;
    body: string;
};

export class SseMessageWebview extends BaseWebview {
    private static readonly jsonPathHistoryKey = 'sseJsonPathHistory';
    private static readonly maxJsonPathHistoryItems = 6;

    private readonly responsePanels = new Map<HttpResponse, WebviewPanel>();
    private readonly panelRounds = new Map<WebviewPanel, SseRound[]>();
    private readonly activePanels = new Set<WebviewPanel>();
    private readonly resendRequestEmitter = new EventEmitter<SseResendRequest>();

    protected get viewType(): string {
        return 'rest-sse-messages';
    }

    protected get previewActiveContextKey(): string {
        return 'sseMessagesPreviewFocus';
    }

    public constructor(context: ExtensionContext) {
        super(context);
    }

    public get onDidRequestResend(): Event<SseResendRequest> {
        return this.resendRequestEmitter.event;
    }

    public async render(response: HttpResponse, column?: ViewColumn, previousResponse?: HttpResponse) {
        const existingPanel = previousResponse && this.responsePanels.get(previousResponse);
        if (existingPanel) {
            const rounds = this.panelRounds.get(existingPanel)!;
            const processor = new SseMessageProcessor();
            processor.setPath(rounds[0]?.processor.currentPath || '$');
            rounds.push({ response, processor });
            this.responsePanels.set(response, existingPanel);
            this.activePanels.add(existingPanel);
            await existingPanel.webview.postMessage({
                command: 'startRound',
                requestBody: this.getRequestBody(response),
                roundNumber: rounds.length
            });
            existingPanel.reveal(column, true);
            return;
        }

        if (!this.settings.showResponseInDifferentTab) {
            disposeAll([...this.panels]);
        }

        const panel = window.createWebviewPanel(
            this.viewType,
            this.getTitle(response),
            { viewColumn: column || ViewColumn.Active, preserveFocus: true },
            {
                enableFindWidget: true,
                enableScripts: true,
                retainContextWhenHidden: true
            });
        const processor = new SseMessageProcessor();
        const initialPath = this.getJsonPathHistory()[0] || '$';
        processor.setPath(initialPath);
        this.panels.push(panel);
        this.responsePanels.set(response, panel);
        this.panelRounds.set(panel, [{ response, processor }]);
        this.activePanels.add(panel);
        panel.iconPath = this.iconFilePath;
        panel.webview.html = this.getHtml(panel);

        const messageDisposable = panel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'ready') {
                await panel.webview.postMessage({
                    command: 'initialize',
                    path: processor.currentPath,
                    history: this.getJsonPathHistory(),
                    rounds: this.getRoundSnapshots(panel),
                    requestBody: this.getRequestBody(response),
                    sending: this.activePanels.has(panel),
                    ...this.getCounts(panel)
                });
            } else if (message.command === 'setJsonPath') {
                try {
                    const path = typeof message.path === 'string' ? message.path : '$';
                    const rounds = this.panelRounds.get(panel) || [];
                    const results = rounds.map(round => round.processor.setPath(path));
                    await panel.webview.postMessage({
                        command: 'replaceRounds',
                        rounds: results,
                        ...this.getCounts(panel)
                    });
                    await this.rememberJsonPath(rounds[0]?.processor.currentPath || '$');
                } catch (error) {
                    await panel.webview.postMessage({
                        command: 'queryError',
                        error: error?.message || String(error)
                    });
                }
            } else if (message.command === 'deleteJsonPath' && typeof message.path === 'string') {
                await this.deleteJsonPath(message.path);
            } else if (message.command === 'resendRequest' && typeof message.body === 'string'
                && !this.activePanels.has(panel)) {
                const rounds = this.panelRounds.get(panel) || [];
                const latestRound = rounds[rounds.length - 1];
                if (latestRound) {
                    this.activePanels.add(panel);
                    await panel.webview.postMessage({ command: 'resendState', sending: true });
                    this.resendRequestEmitter.fire({ response: latestRound.response, body: message.body });
                }
            }
        });

        panel.onDidDispose(() => {
            messageDisposable.dispose();
            const index = this.panels.indexOf(panel);
            if (index !== -1) {
                this.panels.splice(index, 1);
            }
            const rounds = this.panelRounds.get(panel) || [];
            for (const round of rounds) {
                this.responsePanels.delete(round.response);
            }
            this.panelRounds.delete(panel);
            this.activePanels.delete(panel);
            if (this.panels.length === 0) {
                this._onDidCloseAllWebviewPanels.fire();
            }
        });

        panel.reveal(column, true);
    }

    public async append(response: HttpResponse, event: string) {
        const panel = this.responsePanels.get(response);
        const rounds = panel && this.panelRounds.get(panel);
        const roundIndex = rounds?.findIndex(round => round.response === response) ?? -1;
        const processor = roundIndex === -1 ? undefined : rounds![roundIndex].processor;
        if (!panel || !rounds || !processor) {
            return;
        }

        try {
            const result = processor.appendEvent(event);
            if (result) {
                await panel.webview.postMessage({
                    command: 'appendMatches',
                    roundIndex,
                    items: result.items,
                    ...this.getCounts(panel)
                });
            }
        } catch (error) {
            await panel.webview.postMessage({
                command: 'queryError',
                error: error?.message || String(error)
            });
        }
    }

    public async complete(response: HttpResponse) {
        const panel = this.responsePanels.get(response);
        if (!panel) {
            return;
        }
        const rounds = this.panelRounds.get(panel) || [];
        if (rounds[rounds.length - 1]?.response !== response) {
            return;
        }
        this.activePanels.delete(panel);
        await panel.webview.postMessage({
            command: 'resendState',
            sending: false,
            requestBody: this.getRequestBody(response)
        });
    }

    public async failResend(response: HttpResponse, error: string) {
        const panel = this.responsePanels.get(response);
        if (!panel) {
            return;
        }
        this.activePanels.delete(panel);
        await panel.webview.postMessage({ command: 'resendError', error });
    }

    public dispose() {
        this.resendRequestEmitter.dispose();
        disposeAll([...this.panels]);
    }

    private getRoundSnapshots(panel: WebviewPanel): SseQueryResult[] {
        return (this.panelRounds.get(panel) || []).map(round => round.processor.snapshot());
    }

    private getCounts(panel: WebviewPanel) {
        return (this.panelRounds.get(panel) || []).reduce((counts, round) => ({
            messageCount: counts.messageCount + round.processor.messageCount,
            matchCount: counts.matchCount + round.processor.currentMatchCount
        }), { messageCount: 0, matchCount: 0 });
    }

    private getRequestBody(response: HttpResponse): string {
        return typeof response.request.body === 'string'
            ? response.request.body
            : response.request.rawBody || '';
    }

    private getJsonPathHistory(): string[] {
        const storedHistory = this.context.globalState.get<unknown>(SseMessageWebview.jsonPathHistoryKey);
        if (!Array.isArray(storedHistory)) {
            return [];
        }

        const history: string[] = [];
        for (const item of storedHistory) {
            if (typeof item !== 'string') {
                continue;
            }
            const path = item.trim();
            if (path && !history.includes(path)) {
                history.push(path);
            }
            if (history.length === SseMessageWebview.maxJsonPathHistoryItems) {
                break;
            }
        }
        return history;
    }

    private async rememberJsonPath(path: string) {
        const history = this.getJsonPathHistory().filter(item => item !== path);
        history.unshift(path);
        await this.context.globalState.update(
            SseMessageWebview.jsonPathHistoryKey,
            history.slice(0, SseMessageWebview.maxJsonPathHistoryItems));
        await this.broadcastJsonPathHistory();
    }

    private async deleteJsonPath(path: string) {
        const history = this.getJsonPathHistory().filter(item => item !== path.trim());
        await this.context.globalState.update(SseMessageWebview.jsonPathHistoryKey, history);
        await this.broadcastJsonPathHistory();
    }

    private async broadcastJsonPathHistory() {
        const history = this.getJsonPathHistory();
        await Promise.all(this.panels.map(panel => panel.webview.postMessage({
            command: 'historyUpdated',
            history
        })));
    }

    private getTitle(response: HttpResponse): string {
        return response.request.name
            ? `${response.request.name} SSE Messages`
            : 'SSE Messages';
    }

    private getHtml(panel: WebviewPanel): string {
        const nonce = new Date().getTime() + '' + new Date().getMilliseconds();
        const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' vscode-resource:;">`;
        return `
    <head>
        <link rel="stylesheet" type="text/css" href="${panel.webview.asWebviewUri(this.baseFilePath)}">
        <link rel="stylesheet" type="text/css" href="${panel.webview.asWebviewUri(this.vscodeStyleFilePath)}">
        ${csp}
        <style>
            body { padding-top: 0; min-height: 100vh; display: flex; flex-direction: column; }
            .query-panel {
                position: sticky;
                top: 0;
                z-index: 1;
                padding: 12px 0 10px;
                background: var(--vscode-editor-background);
                border-bottom: 1px solid var(--vscode-panel-border);
            }
            .query-panel label { display: block; margin-bottom: 6px; }
            .query-row { display: flex; gap: 8px; }
            .query-input { position: relative; display: flex; flex: 1; min-width: 0; }
            .query-input input { flex: 1; min-width: 0; box-sizing: border-box; }
            .query-row > button { width: auto; min-width: 72px; padding-left: 12px; padding-right: 12px; }
            #history-toggle {
                width: 32px;
                flex: 0 0 32px;
                padding: 0;
                color: var(--vscode-button-secondaryForeground);
                background: var(--vscode-button-secondaryBackground);
                border-left: 1px solid var(--vscode-input-border);
            }
            #history-toggle:hover { background: var(--vscode-button-secondaryHoverBackground); }
            #history-menu {
                position: absolute;
                top: calc(100% + 3px);
                right: 0;
                left: 0;
                z-index: 2;
                padding: 4px;
                background: var(--vscode-dropdown-background);
                border: 1px solid var(--vscode-dropdown-border);
                box-shadow: 0 2px 8px var(--vscode-widget-shadow);
            }
            #history-menu[hidden] { display: none; }
            .history-item { display: flex; align-items: stretch; min-width: 0; }
            .history-item + .history-item { margin-top: 2px; }
            .history-value, .history-delete {
                width: auto;
                color: var(--vscode-dropdown-foreground);
                background: transparent;
            }
            .history-value {
                flex: 1;
                min-width: 0;
                padding: 5px 8px;
                overflow: hidden;
                text-align: left;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .history-delete { flex: 0 0 30px; padding: 0; font-size: 16px; }
            .history-value:hover, .history-delete:hover,
            .history-value[aria-selected="true"] { background: var(--vscode-list-hoverBackground); }
            .history-empty { padding: 7px 8px; color: var(--vscode-descriptionForeground); }
            #query-error { color: var(--vscode-errorForeground); margin-top: 6px; }
            #query-error:empty { display: none; }
            #query-status { color: var(--vscode-descriptionForeground); margin-top: 6px; }
            #content { flex: 1; }
            #empty-state { color: var(--vscode-descriptionForeground); padding: 18px 10px; }
            #result {
                padding: 10px;
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                line-height: 1.5;
                white-space: pre-wrap;
                word-break: break-word;
            }
            .round-divider {
                display: flex;
                align-items: center;
                gap: 10px;
                margin: 18px 0;
                color: var(--vscode-descriptionForeground);
                white-space: nowrap;
            }
            .round-divider::before, .round-divider::after {
                content: '';
                height: 1px;
                flex: 1;
                background: var(--vscode-panel-border);
            }
            .request-panel {
                position: sticky;
                bottom: 0;
                z-index: 1;
                padding: 10px 0 12px;
                background: var(--vscode-editor-background);
                border-top: 1px solid var(--vscode-panel-border);
            }
            .request-panel label { display: block; margin-bottom: 6px; }
            .request-row { display: flex; align-items: stretch; gap: 8px; }
            .request-row textarea { min-height: 58px; max-height: 220px; resize: vertical; box-sizing: border-box; }
            .request-row button { width: auto; min-width: 72px; padding: 0 12px; }
            #request-status { min-height: 1.2em; margin-top: 6px; color: var(--vscode-descriptionForeground); }
            #request-status.error { color: var(--vscode-errorForeground); }
        </style>
        <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
            let matchCount = 0;
            let history = [];

            function updateStatus(messageCount, matches) {
                matchCount = matches;
                document.getElementById('query-status').textContent =
                    'Messages: ' + messageCount + ' · Matches: ' + matches;
                document.getElementById('empty-state').hidden = matches !== 0;
            }

            function appendItems(items) {
                const result = document.getElementById('result');
                items.forEach(function (item) {
                    if (item.merge) {
                        result.appendChild(document.createTextNode(item.text));
                        return;
                    }
                    if (result.textContent && !result.textContent.endsWith('\\n')) {
                        result.appendChild(document.createTextNode('\\n'));
                    }
                    result.appendChild(document.createTextNode(item.text));
                    if (!item.text.endsWith('\\n')) {
                        result.appendChild(document.createTextNode('\\n'));
                    }
                });
            }

            function appendRoundDivider(roundNumber) {
                const divider = document.createElement('div');
                divider.className = 'round-divider';
                divider.textContent = 'Round ' + roundNumber;
                document.getElementById('result').appendChild(divider);
            }

            function renderRounds(rounds) {
                const result = document.getElementById('result');
                result.textContent = '';
                rounds.forEach(function (round, index) {
                    if (index > 0) {
                        appendRoundDivider(index + 1);
                    }
                    appendItems(round.items);
                });
            }

            function setSending(sending, status) {
                const button = document.getElementById('send-request');
                const requestStatus = document.getElementById('request-status');
                button.disabled = sending;
                button.textContent = sending ? 'Sending...' : 'Send';
                requestStatus.className = '';
                requestStatus.textContent = status || (sending ? 'Waiting for SSE response...' : 'Ready');
            }

            function submitRequest() {
                if (document.getElementById('send-request').disabled) {
                    return;
                }
                setSending(true, 'Sending request...');
                vscode.postMessage({
                    command: 'resendRequest',
                    body: document.getElementById('request-body').value
                });
            }

            function submitPath() {
                vscode.postMessage({
                    command: 'setJsonPath',
                    path: document.getElementById('jsonpath').value
                });
            }

            function setHistoryOpen(open) {
                const menu = document.getElementById('history-menu');
                const toggle = document.getElementById('history-toggle');
                menu.hidden = !open;
                toggle.setAttribute('aria-expanded', String(open));
            }

            function renderHistory() {
                const menu = document.getElementById('history-menu');
                const currentPath = document.getElementById('jsonpath').value.trim() || '$';
                menu.textContent = '';
                if (history.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'history-empty';
                    empty.textContent = 'No history yet';
                    menu.appendChild(empty);
                    return;
                }

                history.forEach(function (path) {
                    const item = document.createElement('div');
                    item.className = 'history-item';

                    const select = document.createElement('button');
                    select.type = 'button';
                    select.className = 'history-value';
                    select.textContent = path;
                    select.title = path;
                    select.setAttribute('role', 'option');
                    select.setAttribute('aria-selected', String(path === currentPath));
                    select.addEventListener('click', function () {
                        document.getElementById('jsonpath').value = path;
                        setHistoryOpen(false);
                        submitPath();
                    });

                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.className = 'history-delete';
                    remove.textContent = '\u00d7';
                    remove.title = 'Delete from history';
                    remove.setAttribute('aria-label', 'Delete ' + path + ' from history');
                    remove.addEventListener('click', function () {
                        vscode.postMessage({ command: 'deleteJsonPath', path: path });
                    });

                    item.appendChild(select);
                    item.appendChild(remove);
                    menu.appendChild(item);
                });
            }

            window.addEventListener('message', function (event) {
                const message = event.data;
                if (message.command === 'initialize') {
                    history = message.history;
                    document.getElementById('jsonpath').value = message.path;
                    document.getElementById('request-body').value = message.requestBody;
                    renderRounds(message.rounds);
                    updateStatus(message.messageCount, message.matchCount);
                    renderHistory();
                    setSending(message.sending);
                } else if (message.command === 'replaceRounds') {
                    document.getElementById('query-error').textContent = '';
                    renderRounds(message.rounds);
                    updateStatus(message.messageCount, message.matchCount);
                } else if (message.command === 'appendMatches') {
                    appendItems(message.items);
                    updateStatus(message.messageCount, message.matchCount);
                } else if (message.command === 'queryError') {
                    document.getElementById('query-error').textContent = message.error;
                } else if (message.command === 'historyUpdated') {
                    history = message.history;
                    renderHistory();
                } else if (message.command === 'startRound') {
                    appendRoundDivider(message.roundNumber);
                    document.getElementById('request-body').value = message.requestBody;
                    setSending(true, 'Receiving SSE response...');
                } else if (message.command === 'resendState') {
                    if (typeof message.requestBody === 'string') {
                        document.getElementById('request-body').value = message.requestBody;
                    }
                    setSending(message.sending);
                } else if (message.command === 'resendError') {
                    setSending(false);
                    const requestStatus = document.getElementById('request-status');
                    requestStatus.className = 'error';
                    requestStatus.textContent = message.error;
                }
            });

            document.addEventListener('DOMContentLoaded', function () {
                const form = document.getElementById('query-form');
                const input = document.getElementById('jsonpath');
                form.addEventListener('submit', function (event) {
                    event.preventDefault();
                    submitPath();
                });
                document.getElementById('history-toggle').addEventListener('click', function () {
                    renderHistory();
                    setHistoryOpen(document.getElementById('history-menu').hidden);
                });
                document.addEventListener('click', function (event) {
                    if (!document.querySelector('.query-input').contains(event.target)) {
                        setHistoryOpen(false);
                    }
                });
                document.addEventListener('keydown', function (event) {
                    if (event.key === 'Escape') {
                        setHistoryOpen(false);
                        input.focus();
                    }
                });
                document.getElementById('request-form').addEventListener('submit', function (event) {
                    event.preventDefault();
                    submitRequest();
                });
                document.getElementById('request-body').addEventListener('keydown', function (event) {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        submitRequest();
                    }
                });
                vscode.postMessage({ command: 'ready' });
            });
        </script>
    </head>
    <body>
        <form id="query-form" class="query-panel">
            <label for="jsonpath">JSONPath expression</label>
            <div class="query-row">
                <div class="query-input">
                    <input id="jsonpath" type="text" value="$" spellcheck="false" autocomplete="off" aria-label="JSONPath expression">
                    <button id="history-toggle" type="button" title="JSONPath history" aria-label="Show JSONPath history" aria-haspopup="listbox" aria-expanded="false">&#9662;</button>
                    <div id="history-menu" role="listbox" aria-label="JSONPath history" hidden></div>
                </div>
                <button type="submit">Apply</button>
            </div>
            <div id="query-error" role="alert"></div>
            <div id="query-status">Messages: 0 · Matches: 0</div>
        </form>
        <div id="content">
            <div id="empty-state">No matching content yet.</div>
            <div id="result"></div>
        </div>
        <form id="request-form" class="request-panel">
            <label for="request-body">Next request body</label>
            <div class="request-row">
                <textarea id="request-body" spellcheck="false" aria-label="Next request body"></textarea>
                <button id="send-request" type="submit" disabled>Sending...</button>
            </div>
            <div id="request-status" aria-live="polite">Waiting for SSE response...</div>
        </form>
    </body>`;
    }
}
