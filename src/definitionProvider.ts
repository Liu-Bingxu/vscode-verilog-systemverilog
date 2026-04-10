import * as vscode from 'vscode';
import { Parser } from 'web-tree-sitter';
import { DependencyScanner } from './dependencyScanner';
import { getParsedDocument } from './verilogParser';

export function createDefinitionProvider(
    parser: Parser,
    srcScanner: DependencyScanner,
    simScanner: DependencyScanner,
    socScanner: DependencyScanner
): vscode.DefinitionProvider {
    return {
        async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | undefined> {
            const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_$]*/);
            if (!wordRange) return undefined;
            const word = document.getText(wordRange);
            if (!word) return undefined;

            // 1. 检查是否为模块实例化名（跨文件）
            const scanners = [srcScanner, simScanner, socScanner];
            for (const scanner of scanners) {
                const modules = scanner.getModules();
                const moduleInfo = modules.get(word);
                if (moduleInfo && moduleInfo.kind === 'module' && moduleInfo.file) {
                    const uri = vscode.Uri.file(moduleInfo.file);
                    const range = moduleInfo.range ? new vscode.Range(moduleInfo.range.line, moduleInfo.range.character, moduleInfo.range.line, moduleInfo.range.character) : new vscode.Range(0, 0, 0, 0);
                    return new vscode.Location(uri, range);
                }
            }

            // 2. 当前文件内的符号
            let parsed;
            try {
                parsed = await getParsedDocument(document, parser);
            } catch {
                return undefined;
            }
            const matched = parsed.symbols.find(s => s.name === word);
            if (matched) {
                const uri = vscode.Uri.file(matched.file);
                const range = new vscode.Range(matched.line, matched.column, matched.line, matched.column + word.length);
                return new vscode.Location(uri, range);
            }

            return undefined;
        }
    };
}
