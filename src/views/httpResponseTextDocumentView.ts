import { EOL } from 'os';
import { languages, Position, Range, TextDocument, ViewColumn, window, workspace, WorkspaceEdit } from 'vscode';
import { SystemSettings } from '../models/configurationSettings';
import { HttpResponse } from '../models/httpResponse';
import { PreviewOption } from '../models/previewOption';
import { MimeUtility } from '../utils/mimeUtility';
import { formatHeaders } from '../utils/misc';
import { ResponseFormatUtility } from '../utils/responseFormatUtility';

export class HttpResponseTextDocumentView {

    private readonly settings: SystemSettings = SystemSettings.Instance;

    protected readonly documents: TextDocument[] = [];

    private readonly streamingDocuments = new Map<HttpResponse, TextDocument>();

    public constructor() {
        workspace.onDidCloseTextDocument(e => {
            const index = this.documents.indexOf(e);
            if (index !== -1) {
                this.documents.splice(index, 1);
            }
            for (const [response, document] of this.streamingDocuments) {
                if (document === e) {
                    this.streamingDocuments.delete(response);
                }
            }
        });
    }

    public async render(response: HttpResponse, column?: ViewColumn) {
        const content = this.getTextDocumentContent(response);
        const language = this.getVSCodeDocumentLanguageId(response);
        let document: TextDocument;
        if (this.settings.showResponseInDifferentTab || this.documents.length === 0) {
            document = await workspace.openTextDocument({ language, content });
            this.documents.push(document);
            await window.showTextDocument(document, { viewColumn: column, preserveFocus: !this.settings.previewResponsePanelTakeFocus, preview: false });
        } else {
            document = this.documents[this.documents.length - 1];
            languages.setTextDocumentLanguage(document, language);
            const editor = await window.showTextDocument(document, { viewColumn: column, preserveFocus: !this.settings.previewResponsePanelTakeFocus, preview: false });
            editor.edit(edit => {
                const startPosition = new Position(0, 0);
                const endPosition = document.lineAt(document.lineCount - 1).range.end;
                edit.replace(new Range(startPosition, endPosition), content);
            });
        }
    }

    public async renderStreaming(response: HttpResponse, column?: ViewColumn) {
        const content = this.getTextDocumentContent(response, false);
        const language = this.getVSCodeDocumentLanguageId(response);
        const document = await workspace.openTextDocument({ language, content });
        this.documents.push(document);
        this.streamingDocuments.set(response, document);
        await window.showTextDocument(document, {
            viewColumn: column,
            preserveFocus: !this.settings.previewResponsePanelTakeFocus,
            preview: false
        });
    }

    public async appendStreamingBody(response: HttpResponse, event: string) {
        if (this.settings.previewOption === PreviewOption.Headers) {
            return;
        }

        const document = this.streamingDocuments.get(response);
        if (!document || document.isClosed) {
            return;
        }

        const end = document.lineAt(document.lineCount - 1).range.end;
        const edit = new WorkspaceEdit();
        edit.insert(document.uri, end, event);
        if (!await workspace.applyEdit(edit)) {
            throw new Error('Unable to append the latest SSE event to the response document.');
        }
    }

    private getTextDocumentContent(response: HttpResponse, includeBody: boolean = true): string {
        let content = '';
        const previewOption = this.settings.previewOption;
        if (previewOption === PreviewOption.Exchange) {
            // for add request details
            const request = response.request;
            content += `${request.method} ${request.url} HTTP/1.1${EOL}`;
            content += formatHeaders(request.headers);
            if (request.body) {
                if (typeof request.body !== 'string') {
                    request.body = 'NOTE: Request Body From Is File Not Shown';
                }
                content += `${EOL}${ResponseFormatUtility.formatBody(request.body.toString(), request.contentType, true)}${EOL}`;
            }

            content += EOL.repeat(2);
        }

        if (previewOption !== PreviewOption.Body) {
            content += `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}${EOL}`;
            content += formatHeaders(response.headers);
        }

        if (previewOption !== PreviewOption.Headers && includeBody) {
            const prefix = previewOption === PreviewOption.Body ? '' : EOL;
            content += `${prefix}${ResponseFormatUtility.formatBody(response.body, response.contentType, true)}`;
        }

        return content;
    }

    private getVSCodeDocumentLanguageId(response: HttpResponse) {
        if (this.settings.previewOption === PreviewOption.Body) {
            const contentType = response.contentType;
            if (MimeUtility.isJSON(contentType)) {
                return 'json';
            } else if (MimeUtility.isJavaScript(contentType)) {
                return 'javascript';
            } else if (MimeUtility.isXml(contentType)) {
                return 'xml';
            } else if (MimeUtility.isHtml(contentType)) {
                return 'html';
            } else if (MimeUtility.isCSS(contentType)) {
                return 'css';
            }
        }

        return 'http';
    }
}
