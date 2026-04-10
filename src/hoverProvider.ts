import * as vscode from 'vscode';
import { Parser } from 'web-tree-sitter';
import { DependencyScanner } from './dependencyScanner';
import { getParsedDocument } from './verilogParser';

interface SymbolInfo {
    name: string;
    kind: 'port' | 'param' | 'signal';
    direction?: string;
    type?: string;
    packedWidth?: string;   // 打包维度，如 [7:0]
    unpackedWidth?: string; // 解包维度，如 [15:0]
    value?: string;         // 参数默认值
    line: number;
    column: number;
    file: string;
}

export function createHoverProvider(
    parser: Parser,
    srcScanner: DependencyScanner,
    simScanner: DependencyScanner,
    socScanner: DependencyScanner
): vscode.HoverProvider {
    return {
        async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken):  Promise<vscode.Hover | null> {
            const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_$]*/);
            if (!wordRange) return null;
            const word = document.getText(wordRange);
            if (!word) return null;

             // 获取解析后的符号列表
            let parsed;
            try {
                parsed = await getParsedDocument(document, parser);
            } catch {
                return null;
            }

            // 查找匹配的符号
            const matched = parsed.symbols.find(s => s.name === word);
            if (matched) {
                const markdown = new vscode.MarkdownString();
                let typeStr = '';
                if (matched.kind === 'port') {
                    const widthPart = matched.packedWidth ? ' ' + matched.packedWidth : '';
                    typeStr = `${matched.direction} ${matched.type} ${widthPart} ${matched.name}`;
                } else if (matched.kind === 'param') {
                    typeStr = `${matched.type} ${matched.name} = ${matched.value}`;
                } else { // signal
                    const packedPart = matched.packedWidth ? ' ' + matched.packedWidth : '';
                    const unpackedPart = matched.unpackedWidth ? ' ' + matched.unpackedWidth : '';
                    typeStr = `${matched.type} ${packedPart} ${matched.name} ${unpackedPart}`;
                }
                markdown.appendMarkdown(`**${word}**\n`);
                markdown.appendMarkdown(`- **Type**: ${typeStr}\n`);
                markdown.appendMarkdown(`- **Defined at**: ${matched.file}:${matched.line + 1}:${matched.column + 1}\n`);
                markdown.isTrusted = true;
                return new vscode.Hover(markdown);
            }

            // 跨文件模块实例化悬停
            const scanners = [srcScanner, simScanner, socScanner];
            for (const scanner of scanners) {
                const modules = scanner.getModules();
                const moduleInfo = modules.get(word);
                if (moduleInfo && moduleInfo.kind === 'module' && moduleInfo.file) {
                    const markdown = new vscode.MarkdownString();
                    markdown.appendMarkdown(`**Module: ${word}**\n`);
                    markdown.appendMarkdown(`- **Defined in**: ${moduleInfo.file}${moduleInfo.range ? `:${moduleInfo.range.line + 1}` : ''}\n`);
                    markdown.isTrusted = true;
                    return new vscode.Hover(markdown);
                }
            }

            return null;
        }
    };
}
