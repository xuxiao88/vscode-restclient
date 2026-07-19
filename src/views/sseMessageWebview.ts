import { ExtensionContext, ViewColumn, WebviewPanel, window } from 'vscode';
import { HttpResponse } from '../models/httpResponse';
import { disposeAll } from '../utils/dispose';
import { SseMessageProcessor, SseQueryResult } from '../utils/sseMessageProcessor';
import { BaseWebview } from './baseWebview';

export class SseMessageWebview extends BaseWebview {
    private readonly responsePanels = new Map<HttpResponse, WebviewPanel>();
    private readonly panelProcessors = new Map<WebviewPanel, SseMessageProcessor>();

    protected get viewType(): string {
        return 'rest-sse-messages';
    }

    protected get previewActiveContextKey(): string {
        return 'sseMessagesPreviewFocus';
    }

    public constructor(context: ExtensionContext) {
        super(context);
    }

    public async render(response: HttpResponse, column: ViewColumn) {
        if (!this.settings.showResponseInDifferentTab) {
            disposeAll([...this.panels]);
        }

        const panel = window.createWebviewPanel(
            this.viewType,
            this.getTitle(response),
            { viewColumn: column, preserveFocus: true },
            {
                enableFindWidget: true,
                enableScripts: true,
                retainContextWhenHidden: true
            });
        const processor = new SseMessageProcessor();
        this.panels.push(panel);
        this.responsePanels.set(response, panel);
        this.panelProcessors.set(panel, processor);
        panel.iconPath = this.iconFilePath;
        panel.webview.html = this.getHtml(panel);

        const messageDisposable = panel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'ready') {
                await this.postResult(panel, 'replaceMatches', processor.snapshot());
            } else if (message.command === 'setJsonPath') {
                try {
                    const result = processor.setPath(typeof message.path === 'string' ? message.path : '$');
                    await this.postResult(panel, 'replaceMatches', result);
                } catch (error) {
                    await panel.webview.postMessage({
                        command: 'queryError',
                        error: error?.message || String(error)
                    });
                }
            }
        });

        panel.onDidDispose(() => {
            messageDisposable.dispose();
            const index = this.panels.indexOf(panel);
            if (index !== -1) {
                this.panels.splice(index, 1);
            }
            this.panelProcessors.delete(panel);
            this.responsePanels.delete(response);
            if (this.panels.length === 0) {
                this._onDidCloseAllWebviewPanels.fire();
            }
        });

        panel.reveal(column, true);
    }

    public async append(response: HttpResponse, event: string) {
        const panel = this.responsePanels.get(response);
        const processor = panel && this.panelProcessors.get(panel);
        if (!panel || !processor) {
            return;
        }

        try {
            const result = processor.appendEvent(event);
            if (result) {
                await this.postResult(panel, 'appendMatches', result);
            }
        } catch (error) {
            await panel.webview.postMessage({
                command: 'queryError',
                error: error?.message || String(error)
            });
        }
    }

    public dispose() {
        disposeAll([...this.panels]);
    }

    private async postResult(panel: WebviewPanel, command: string, result: SseQueryResult) {
        await panel.webview.postMessage({ command, ...result });
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
            body { padding-top: 0; }
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
            .query-row input { flex: 1; box-sizing: border-box; }
            .query-row button { width: auto; min-width: 72px; padding-left: 12px; padding-right: 12px; }
            #query-error { color: var(--vscode-errorForeground); margin-top: 6px; }
            #query-error:empty { display: none; }
            #query-status { color: var(--vscode-descriptionForeground); margin-top: 6px; }
            #empty-state { color: var(--vscode-descriptionForeground); padding: 18px 10px; }
            #result { padding: 10px 0; white-space: pre-wrap; word-break: break-word; }
        </style>
        <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
            let debounceTimer;
            let matchCount = 0;

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

            function submitPath() {
                vscode.postMessage({
                    command: 'setJsonPath',
                    path: document.getElementById('jsonpath').value
                });
            }

            window.addEventListener('message', function (event) {
                const message = event.data;
                if (message.command === 'replaceMatches') {
                    document.getElementById('result').textContent = '';
                    document.getElementById('query-error').textContent = '';
                    appendItems(message.items);
                    updateStatus(message.messageCount, message.matchCount);
                } else if (message.command === 'appendMatches') {
                    appendItems(message.items);
                    updateStatus(message.messageCount, message.matchCount);
                } else if (message.command === 'queryError') {
                    document.getElementById('query-error').textContent = message.error;
                }
            });

            document.addEventListener('DOMContentLoaded', function () {
                const form = document.getElementById('query-form');
                const input = document.getElementById('jsonpath');
                form.addEventListener('submit', function (event) {
                    event.preventDefault();
                    submitPath();
                });
                input.addEventListener('input', function () {
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(submitPath, 300);
                });
                vscode.postMessage({ command: 'ready' });
            });
        </script>
    </head>
    <body>
        <form id="query-form" class="query-panel">
            <label for="jsonpath">JSONPath expression</label>
            <div class="query-row">
                <input id="jsonpath" type="text" value="$" spellcheck="false" aria-label="JSONPath expression">
                <button type="submit">Apply</button>
            </div>
            <div id="query-error" role="alert"></div>
            <div id="query-status">Messages: 0 · Matches: 0</div>
        </form>
        <div id="empty-state">No matching content yet.</div>
        <pre><code id="result"></code></pre>
    </body>`;
    }
}
