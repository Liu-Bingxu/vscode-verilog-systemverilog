import { Parser } from 'web-tree-sitter';
import * as vscode from 'vscode';
import { getParsedDocument } from './verilogParser';

export class VerilogDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    private parser: Parser;

    constructor(parser: Parser) {
        this.parser = parser;
    }

    async provideDocumentSymbols(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]> {
        try {
            const parsed = await getParsedDocument(document, this.parser);
            return parsed.documentSymbols;
        } catch (err) {
            vscode.window.showWarningMessage(`DocumentSymbolProvider error: ${err}`);
            return [];
        }
    }
}
